// Migração única: aba original (legada) -> aba Dados normalizada.
//
// A aba original NÃO é escrita em momento nenhum. Ela é só lida. Por isso a
// migração é sempre refazível: apague a aba Dados e rode de novo.
//
// O que a aba original é, na prática: várias sub-tabelas numa aba só, separadas
// por linhas mescladas de seção, com dois cabeçalhos diferentes (7 e 8 colunas),
// e com status e data escritos em prosa dentro da coluna Observação.

import { CONFIG } from './config.js';
import { readRaw, createMany, readAll, ensureDataSheet, findLegacySheetTitle } from './sheets.js';

/* ------------------------------------------------------------- classificação */

/** Linha mesclada de seção: o Sheets devolve o valor só na primeira célula. */
const isSectionRow = (cells) =>
  !!cells[0]?.trim() && cells.slice(1).every((c) => !c?.trim());

const isHeaderRow = (cells) =>
  /^nome da empresa$/i.test((cells[0] || '').trim());

const isEmptyRow = (cells) => cells.every((c) => !c?.trim());

/** Conta dígitos: cidade nunca tem 8+, telefone sempre tem. */
const looksLikePhone = (s) => ((s || '').match(/\d/g) || []).length >= 8;

/** Colapsa espaços e quebras de linha internas em espaço simples. */
const norm = (s) => (s ?? '').toString().replace(/\s+/g, ' ').trim();

/**
 * Telefone pode vir com mais de um número na MESMA célula, separados por quebra
 * de linha (é o caso da Aurora Coop, Eliane, Menegotti e SCGÁS). Vira " / ".
 */
const normTel = (s) => (s ?? '').toString()
  .split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean).join(' / ')
  .replace(/\s+/g, ' ').trim();

/**
 * Categoria a partir do texto da seção. A ordem importa: "OUTROS ESTADOS —
 * PPCI NACIONAL" precisa cair em PPCI, não na regra genérica de sub-seção.
 */
function categoriaFromSection(text, atual) {
  const t = text.toLowerCase();
  if (/vencedoras/.test(t)) return 'Licitação 2026';
  if (/outros anos/.test(t)) return 'Licitação anterior';
  if (/ganharam licita/.test(t)) return 'Licitação 2026';
  // "Base consolidada … focadas em galpões, pavilhões e indústrias" precisa ser
  // testado ANTES do padrão de PPCI: a palavra "indústrias" aparece nos dois.
  if (/base consolidada|j(á|a) contatadas|a contatar/.test(t)) return 'Construtora';
  if (/ppci|galp(ã|a)o pr(ó|o)prio|ind(ú|u)strias/.test(t)) return 'Indústria PPCI';
  return atual;   // sub-seção por UF (RIO GRANDE DO SUL, SANTA CATARINA…)
}

/* ------------------------------------------------------- status e data (prosa) */

/**
 * Converte "20/08" na data ISO mais recente que não seja futura.
 * As datas da base vão de 13/08 a 02/09; sem ano no texto, o ano corrente é o
 * certo — a não ser que isso caia no futuro, aí é do ano passado.
 */
function isoFromDayMonth(dm, hoje = new Date()) {
  const [d, m] = dm.split('/').map(Number);
  if (!d || !m || d > 31 || m > 12) return '';
  let ano = hoje.getFullYear();
  const mk = (y) => new Date(Date.UTC(y, m - 1, d));
  if (mk(ano) > hoje) ano -= 1;
  return mk(ano).toISOString().slice(0, 10);
}

/**
 * Extrai status e data da coluna Observação.
 *
 * A data SÓ é aceita quando vem logo depois do marcador de status. Um
 * \d+/\d+ solto no texto captura lixo: a base tem "Contrato nº 66/2025"
 * (vira 66/20) e outros números de contrato.
 */
export function parseObservacao(obs, hoje = new Date()) {
  const texto = (obs || '').trim();
  if (!texto) return { status: 'Nova', data_contato: '', notas: '', casou: false };

  let m;
  if ((m = texto.match(/^contato feito\s*:?\s*(\d{1,2}\/\d{1,2})?/i))) {
    return {
      status: 'Contatado',
      data_contato: m[1] ? isoFromDayMonth(m[1], hoje) : '',
      notas: texto.slice(m[0].length).replace(/^[\s—–\-;,.]+/, ''),
      casou: true,
    };
  }
  if ((m = texto.match(/^nova\s*\(?\s*(\d{1,2}\/\d{1,2})?\s*\)?/i))) {
    return {
      status: 'Nova',
      data_contato: '',
      notas: texto.slice(m[0].length).replace(/^[\s—–\-;,.]+/, ''),
      casou: true,
    };
  }
  if ((m = texto.match(/^j(á|a)\s+contatada|^contatada/i))) {
    return {
      status: 'Contatado',
      data_contato: '',
      notas: texto.slice(m[0].length).replace(/^[\s—–\-;,.]+/, ''),
      casou: true,
    };
  }
  // Descrição livre do negócio: sem marcador de status, então é lead novo.
  return { status: 'Nova', data_contato: '', notas: texto, casou: false };
}

/* --------------------------------------------------------------- parser geral */

/**
 * Converte os valores crus da aba legada em registros da aba Dados.
 * Não escreve nada — devolve também um relatório para o dry-run.
 */
export function parseLegacy(rows, hoje = new Date()) {
  const registros = [];
  const secoes = [];
  const semMarcador = [];
  let categoria = 'Construtora';
  let deslocadas = 0;
  let ignoradas = 0;

  for (let i = 0; i < rows.length; i++) {
    // Sem trim aqui: o telefone precisa da quebra de linha original (ver normTel).
    const cells = (rows[i] || []).map((c) => (c ?? '').toString());
    const linha = i + 1;   // número da linha como aparece no Sheets

    if (isEmptyRow(cells)) { ignoradas++; continue; }
    if (isHeaderRow(cells)) { ignoradas++; continue; }
    if (isSectionRow(cells)) {
      categoria = categoriaFromSection(cells[0], categoria);
      secoes.push({ linha, texto: cells[0], categoria });
      continue;
    }

    // Deslocamento: o telefone ocupou duas células, empurrando o resto pra direita.
    const deslocada = looksLikePhone(cells[2]);
    if (deslocada) deslocadas++;

    const nome = norm(cells[0]);
    const telefone = deslocada
      ? [normTel(cells[1]), normTel(cells[2])].filter(Boolean).join(' / ')
      : normTel(cells[1]);
    const base = deslocada ? 3 : 2;

    const cidade = norm(cells[base]);
    const uf = norm(cells[base + 1]).replace(/^-$/, '');
    const email = norm(cells[base + 2]);
    const site = norm(cells[base + 3]);
    const obs = norm(cells[base + 4]);
    const extra = norm(cells[base + 5]);   // "Portal/Canal Fornecedores" do bloco PPCI

    if (!nome) { ignoradas++; continue; }

    const { status, data_contato, notas, casou } = parseObservacao(obs, hoje);
    if (!casou && obs) semMarcador.push({ linha, empresa: nome, obs });

    registros.push({
      empresa: nome,
      telefone,
      cidade,
      uf: uf.toUpperCase().length <= 3 ? uf.toUpperCase() : uf,
      email,
      site,
      categoria,
      status,
      data_contato,
      proximo_passo: '',
      feito: '',
      notas: [notas, extra].filter(Boolean).join(' | '),
      responsavel: '',
    });
  }

  const contar = (campo) => registros.reduce((acc, r) => {
    acc[r[campo]] = (acc[r[campo]] || 0) + 1;
    return acc;
  }, {});

  return {
    registros,
    relatorio: {
      linhasLidas: rows.length,
      registros: registros.length,
      ignoradas,
      deslocadas,
      secoes,
      porStatus: contar('status'),
      porCategoria: contar('categoria'),
      semMarcador,
    },
  };
}

/* ---------------------------------------------------------------- orquestração */

/** Lê a aba legada e devolve o que SERIA gravado, sem gravar nada. */
export async function dryRun() {
  const titulo = await findLegacySheetTitle();
  const rows = await readRaw(titulo);
  const { registros, relatorio } = parseLegacy(rows);
  return { titulo, registros, relatorio };
}

/**
 * Grava de verdade. Recusa se a aba Dados já tiver conteúdo, para nunca
 * duplicar a base por um clique repetido.
 */
export async function commit(registros, responsavel) {
  await ensureDataSheet();

  const existentes = await readAll();
  if (existentes.length) {
    throw new Error(
      `A aba "${CONFIG.DATA_SHEET}" já tem ${existentes.length} registros. ` +
      'Para migrar de novo, apague a aba primeiro.'
    );
  }

  const comDono = registros.map((r) => ({ ...r, responsavel: r.responsavel || responsavel || '' }));
  return createMany(comDono);
}
