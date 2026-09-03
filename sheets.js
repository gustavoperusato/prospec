// Wrapper da Google Sheets API v4.
//
// Duas decisões que valem explicação:
//
// 1. valueInputOption=RAW (e não USER_ENTERED). Os telefones da base começam
//    com "+" ("+55 41 3643-3300"). Com USER_ENTERED o Sheets interpreta um
//    valor iniciado por "+" como FÓRMULA e grava #ERROR! na célula. RAW guarda
//    tudo literalmente. Datas ficam como texto ISO (YYYY-MM-DD), que continua
//    ordenando corretamente e é o formato que o app lê e escreve.
//
// 2. Escrita resolvida por `id`, nunca por índice de linha guardado. Índice
//    desloca quando a outra pessoa insere ou apaga algo. Antes de gravar, o app
//    relê a aba e procura a linha pelo id.

import { CONFIG, DATA_RANGE, LAST_COL } from './config.js';
import { getToken, refreshToken } from './auth.js';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let dataSheetId = null;    // gid da aba Dados (necessário para apagar linhas)

/** fetch autenticado, com uma renovação de token em caso de 401. */
async function api(path, { method = 'GET', body, retried = false } = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}/${CONFIG.SPREADSHEET_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 && !retried) {
    // Token expirou (dura ~1h). Renova e repete uma única vez.
    await refreshToken();
    return api(path, { method, body, retried: true });
  }

  if (!res.ok) throw await describeHttpError(res);
  return res.json();
}

async function describeHttpError(res) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch { /* corpo não-JSON */ }

  if (res.status === 403) {
    return new Error(
      'Sem permissão para acessar a planilha. Confirme que sua conta Google tem ' +
      `acesso a ela no Drive.${detail ? ` (${detail})` : ''}`
    );
  }
  if (res.status === 404) {
    return new Error('Planilha não encontrada. Confira o SPREADSHEET_ID em config.js.');
  }
  if (res.status === 429 || res.status >= 500) {
    return new Error(`O Google recusou a chamada agora (${res.status}). Tente de novo em instantes.`);
  }
  return new Error(detail || `Erro ${res.status} na chamada à planilha.`);
}

const enc = (s) => encodeURIComponent(s);

/* ---------------------------------------------------------------- metadados */

export async function getSheets() {
  const meta = await api('?fields=sheets.properties(sheetId,title,gridProperties)');
  return meta.sheets.map((s) => ({
    id: s.properties.sheetId,
    title: s.properties.title,
    rows: s.properties.gridProperties?.rowCount ?? 0,
  }));
}

/** Nome da aba legada: a primeira que não for a aba Dados. */
export async function findLegacySheetTitle() {
  const sheets = await getSheets();
  const legacy = sheets.find((s) => s.title !== CONFIG.DATA_SHEET);
  if (!legacy) throw new Error('Não encontrei a aba original da planilha.');
  return legacy.title;
}

/** Cria a aba Dados com cabeçalho, se ainda não existir. Idempotente. */
export async function ensureDataSheet() {
  const sheets = await getSheets();
  const existing = sheets.find((s) => s.title === CONFIG.DATA_SHEET);

  if (existing) {
    dataSheetId = existing.id;
    return { created: false };
  }

  const resp = await api(':batchUpdate', {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title: CONFIG.DATA_SHEET } } }] },
  });
  dataSheetId = resp.replies[0].addSheet.properties.sheetId;

  await api(`/values/${enc(`${CONFIG.DATA_SHEET}!A1:${LAST_COL}1`)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: { values: [CONFIG.COLUMNS] },
  });

  return { created: true };
}

/* -------------------------------------------------------------------- leitura */

/** Lê a aba Dados inteira. Devolve objetos com `_row` (linha 1-indexada). */
export async function readAll() {
  const resp = await api(`/values/${enc(DATA_RANGE)}`);
  const rows = resp.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1).map((cells, i) => {
    const rec = { _row: i + 2 };   // +1 cabeçalho, +1 porque o Sheets é 1-indexado
    CONFIG.COLUMNS.forEach((col, j) => { rec[col] = cells[j] ?? ''; });
    return rec;
  }).filter((r) => r.id);          // ignora linhas em branco no fim da aba
}

/** Valores crus de uma aba qualquer — usado pela migração. */
export async function readRaw(sheetTitle, lastCol = 'J') {
  const resp = await api(`/values/${enc(`${sheetTitle}!A:${lastCol}`)}`);
  return resp.values || [];
}

/* -------------------------------------------------------------------- escrita */

const toRow = (rec) => CONFIG.COLUMNS.map((c) => rec[c] ?? '');

export async function create(rec) {
  const now = new Date().toISOString();
  const full = { ...rec, id: rec.id || crypto.randomUUID(), criado_em: now, atualizado_em: now };
  await api(
    `/values/${enc(DATA_RANGE)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [toRow(full)] } },
  );
  return full;
}

/** Grava várias linhas de uma vez (migração). */
export async function createMany(recs) {
  if (!recs.length) return 0;
  const now = new Date().toISOString();
  const values = recs.map((r) => toRow({
    ...r, id: r.id || crypto.randomUUID(), criado_em: now, atualizado_em: now,
  }));

  // Lotes para não estourar o limite de tamanho da requisição.
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    await api(
      `/values/${enc(DATA_RANGE)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: { values: values.slice(i, i + CHUNK) } },
    );
  }
  return values.length;
}

/** Localiza a linha atual pelo id e sobrescreve. Relê antes para não gravar por índice velho. */
export async function update(id, patch) {
  const all = await readAll();
  const cur = all.find((r) => r.id === id);
  if (!cur) throw new Error('Este registro não existe mais na planilha (alguém pode ter apagado).');

  const merged = { ...cur, ...patch, id, atualizado_em: new Date().toISOString() };
  delete merged._row;

  await api(
    `/values/${enc(`${CONFIG.DATA_SHEET}!A${cur._row}:${LAST_COL}${cur._row}`)}?valueInputOption=RAW`,
    { method: 'PUT', body: { values: [toRow(merged)] } },
  );
  return merged;
}

/** Apaga a linha. A values API não remove linhas — precisa de deleteDimension. */
export async function remove(id) {
  if (dataSheetId === null) await ensureDataSheet();

  const all = await readAll();
  const cur = all.find((r) => r.id === id);
  if (!cur) return false;   // já não existe: nada a fazer

  await api(':batchUpdate', {
    method: 'POST',
    body: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: dataSheetId,
            dimension: 'ROWS',
            startIndex: cur._row - 1,   // deleteDimension é 0-indexado
            endIndex: cur._row,
          },
        },
      }],
    },
  });
  return true;
}
