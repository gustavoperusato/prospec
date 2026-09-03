// Interface: login -> (migração, se a aba Dados estiver vazia) -> 4 abas.

import { CONFIG } from './config.js';
import * as auth from './auth.js';
import * as sheets from './sheets.js';
import * as migrate from './migrate.js';

const $app = document.getElementById('app');

const state = {
  pronto: false,
  carregando: true,
  registros: [],
  tab: 'hoje',
  busca: '',
  fStatus: '',
  fCategoria: '',
  limite: 60,
  editando: null,      // registro em edição (ou {} para novo)
  migracao: null,      // { registros, relatorio } do dry-run
  erroFatal: null,
};

/* ------------------------------------------------------------------ utils */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Minúsculas e sem acento. No celular ninguém digita "Criciúma" com acento —
 * a busca precisa achar assim mesmo.
 */
const chave = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Data de hoje em YYYY-MM-DD, no fuso local (não em UTC). */
function hojeISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function diasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const brDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '')
  ? iso.slice(8, 10) + '/' + iso.slice(5, 7)
  : (iso || ''));

/** Números de telefone da célula (podem ser vários, separados por " / "). */
function telefones(txt) {
  return String(txt || '').split('/')
    .map((p) => p.trim()).filter((p) => (p.match(/\d/g) || []).length >= 8)
    .map((p) => {
      let d = p.replace(/\D/g, '');
      if (!d.startsWith('55')) d = '55' + d;
      return { rotulo: p.replace(/\s*\(.*?\)\s*/g, '').trim() || p, wa: d };
    });
}

let toastTimer;
function toast(msg, tipo = 'info') {
  document.querySelector('.toast')?.remove();
  const d = document.createElement('div');
  d.className = 'toast';
  d.dataset.tipo = tipo;
  d.textContent = msg;
  document.body.appendChild(d);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => d.remove(), tipo === 'erro' ? 7000 : 3200);
}

const erro = (e) => { console.error(e); toast(e?.message || String(e), 'erro'); };

/* ------------------------------------------------------------------- dados */

async function carregar() {
  state.carregando = true;
  render();
  try {
    await sheets.ensureDataSheet();
    state.registros = await sheets.readAll();
    state.pronto = true;
  } catch (e) {
    erro(e);
    state.erroFatal = e.message;
  } finally {
    state.carregando = false;
    render();
  }
}

async function recarregar() {
  try {
    state.registros = await sheets.readAll();
    render();
  } catch (e) { erro(e); }
}

/* ------------------------------------------------------------------ filtros */

function filtrados() {
  const q = chave(state.busca.trim());
  return state.registros.filter((r) => {
    if (state.fStatus && r.status !== state.fStatus) return false;
    if (state.fCategoria && r.categoria !== state.fCategoria) return false;
    if (!q) return true;
    return [r.empresa, r.cidade, r.uf, r.notas, r.telefone, r.email]
      .some((v) => chave(v).includes(q));
  });
}

const pendentes = () => {
  const h = hojeISO();
  return state.registros
    .filter((r) => r.proximo_passo && r.proximo_passo <= h && r.feito !== 'sim')
    .sort((a, b) => a.proximo_passo.localeCompare(b.proximo_passo));
};

/* ------------------------------------------------------------------ render */

function render() {
  if (state.erroFatal) return void ($app.innerHTML = telaErro());
  if (!auth.isSignedIn()) return void ($app.innerHTML = telaLogin());
  if (state.carregando) return void ($app.innerHTML = cabecalho() + '<main><div class="spinner"></div></main>');
  if (state.migracao) return void ($app.innerHTML = cabecalho() + telaMigracao());
  // A checagem de `editando` vem antes: senão o botão "Começar do zero" da tela
  // vazia nunca conseguiria abrir o formulário.
  if (state.pronto && !state.registros.length && !state.editando) {
    return void ($app.innerHTML = cabecalho() + telaVazia());
  }

  $app.innerHTML = cabecalho() + `<main>${conteudoAba()}</main>` + tabbar()
    + (state.editando ? formulario(state.editando) : '');
}

const telaErro = () => `
  <main><div class="card">
    <h2 style="margin-top:0">Não deu para iniciar</h2>
    <p>${esc(state.erroFatal)}</p>
    <button class="btn-primary" data-acao="recarregar-pagina">Tentar de novo</button>
  </div></main>`;

const telaLogin = () => `
  <div class="tela-login">
    <h1>Prospecção</h1>
    <p>Entre com a conta Google que tem acesso à planilha.</p>
    <button class="btn-primary" data-acao="entrar" style="width:100%">Entrar com Google</button>
    <p class="muted" style="margin-top:20px">
      O app usa sua própria conta para ler e escrever. Quem controla o acesso é o
      compartilhamento da planilha no Drive.
    </p>
  </div>`;

const cabecalho = () => `
  <header>
    <h1>Prospecção</h1>
    <div class="who">
      ${auth.getUserEmail() ? esc(auth.getUserEmail()) : ''}<br>
      <a href="#" data-acao="sair" style="color:var(--text-dim)">sair</a>
    </div>
  </header>`;

const telaVazia = () => `
  <main>
    <div class="aviso">
      A aba <strong>${esc(CONFIG.DATA_SHEET)}</strong> está vazia. Dá para importar
      as empresas que já estão na aba original — ela não é alterada, só lida.
    </div>
    <div class="btn-row">
      <button class="btn-primary" data-acao="dry-run">Importar planilha atual</button>
      <button data-acao="novo">Começar do zero</button>
    </div>
  </main>`;

function telaMigracao() {
  const { relatorio: rel } = state.migracao;
  const linhas = (obj) => Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join('\n');

  return `<main>
    <div class="aviso">
      <strong>Confira antes de gravar.</strong> Nada foi escrito ainda. A aba original
      não será alterada em nenhum momento.
    </div>
    <pre class="relatorio">${esc(
      `linhas lidas na aba original : ${rel.linhasLidas}\n` +
      `registros a criar            : ${rel.registros}\n` +
      `linhas ignoradas             : ${rel.ignoradas} (cabeçalhos e vazias)\n` +
      `seções detectadas            : ${rel.secoes.length}\n` +
      `telefone em célula dupla     : ${rel.deslocadas}\n` +
      `sem marcador de status       : ${rel.semMarcador.length} (viram "Nova")\n\n` +
      `POR STATUS\n${linhas(rel.porStatus)}\n\n` +
      `POR CATEGORIA\n${linhas(rel.porCategoria)}\n\n` +
      `SEÇÕES\n${rel.secoes.map((s) => `  L${String(s.linha).padStart(3)}  [${s.categoria}]  ${s.texto.slice(0, 54)}`).join('\n')}`
    )}</pre>
    <div class="btn-row">
      <button class="btn-primary" data-acao="migrar-confirmar">Gravar ${rel.registros} registros</button>
      <button data-acao="migrar-cancelar">Cancelar</button>
    </div>
  </main>`;
}

function tabbar() {
  const n = pendentes().length;
  const abas = [
    ['hoje', '＋', 'Hoje'],
    ['lista', '☰', 'Lista'],
    ['follow', '✓', 'Follow-ups'],
    ['painel', '▤', 'Painel'],
  ];
  return `<nav>${abas.map(([id, ico, rot]) => `
    <button data-acao="tab" data-tab="${id}" aria-selected="${state.tab === id}">
      <span class="ico">${ico}</span>${rot}
      ${id === 'follow' && n ? `<span class="badge">${n}</span>` : ''}
    </button>`).join('')}</nav>`;
}

function conteudoAba() {
  switch (state.tab) {
    case 'hoje': return abaHoje();
    case 'lista': return abaLista();
    case 'follow': return abaFollow();
    default: return abaPainel();
  }
}

/* ---------------------------------------------------------------- aba: hoje */

function abaHoje() {
  const h = hojeISO();
  const doDia = state.registros.filter((r) => r.data_contato === h);
  return `
    <button class="btn-primary" data-acao="novo" style="width:100%;margin-bottom:14px">
      + Registrar contato
    </button>
    <div class="kpis">
      <div class="kpi"><div class="kpi-n">${doDia.length}</div><div class="kpi-l">contatos hoje</div></div>
      <div class="kpi"><div class="kpi-n">${pendentes().length}</div><div class="kpi-l">follow-ups vencidos</div></div>
    </div>
    <h2>Hoje — ${brDate(h)}</h2>
    ${doDia.length ? doDia.map(cardLead).join('') : '<p class="muted center">Nenhum contato registrado hoje ainda.</p>'}`;
}

/* --------------------------------------------------------------- aba: lista */

function abaLista() {
  const res = filtrados();
  const mostra = res.slice(0, state.limite);
  const opts = (arr, sel) => arr.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

  return `
    <div class="filtros">
      <input type="search" placeholder="Buscar empresa, cidade, nota…" value="${esc(state.busca)}" data-acao="busca">
      <select data-acao="f-status"><option value="">Todo status</option>${opts(CONFIG.STATUSES, state.fStatus)}</select>
      <select data-acao="f-categoria"><option value="">Toda categoria</option>${opts(CONFIG.CATEGORIAS, state.fCategoria)}</select>
    </div>
    <p class="muted">${res.length} de ${state.registros.length} empresas</p>
    ${mostra.map(cardLead).join('')}
    ${res.length > mostra.length
      ? `<button data-acao="mais" style="width:100%">Mostrar mais (${res.length - mostra.length})</button>`
      : ''}`;
}

function cardLead(r) {
  const tels = telefones(r.telefone);
  return `<div class="card">
    <div class="lead">
      <div class="lead-main">
        <div class="lead-nome">${esc(r.empresa)}</div>
        <div class="lead-meta">
          ${esc([r.cidade, r.uf].filter(Boolean).join('/'))}
          ${r.categoria ? ' · ' + esc(r.categoria) : ''}
          ${r.data_contato ? ' · ' + brDate(r.data_contato) : ''}
        </div>
      </div>
      <span class="pill" data-s="${esc(r.status)}">${esc(r.status)}</span>
    </div>
    ${r.notas ? `<div class="lead-meta" style="margin-top:7px">${esc(r.notas.slice(0, 150))}${r.notas.length > 150 ? '…' : ''}</div>` : ''}
    <div class="lead-acoes">
      ${tels.map((t) => `<a href="https://wa.me/${t.wa}" target="_blank" rel="noopener">WhatsApp</a>`).join('')}
      ${tels.map((t) => `<a href="tel:+${t.wa}">Ligar</a>`).join('')}
      ${r.email ? `<a href="mailto:${esc(r.email)}">E-mail</a>` : ''}
      ${r.site ? `<a href="${esc(/^https?:/.test(r.site) ? r.site : 'https://' + r.site)}" target="_blank" rel="noopener">Site</a>` : ''}
      <a href="#" data-acao="editar" data-id="${esc(r.id)}">Editar</a>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- aba: follow */

function abaFollow() {
  const pend = pendentes();
  const futuros = state.registros
    .filter((r) => r.proximo_passo > hojeISO() && r.feito !== 'sim')
    .sort((a, b) => a.proximo_passo.localeCompare(b.proximo_passo)).slice(0, 20);

  const item = (r) => `<div class="card">
    <div class="lead">
      <div class="lead-main">
        <div class="lead-nome">${esc(r.empresa)}</div>
        <div class="lead-meta">${brDate(r.proximo_passo)} · ${esc(r.status)} · ${esc([r.cidade, r.uf].filter(Boolean).join('/'))}</div>
      </div>
      <button class="btn-sm" data-acao="feito" data-id="${esc(r.id)}">Feito</button>
    </div>
  </div>`;

  return `
    <h2>Vencidos e para hoje (${pend.length})</h2>
    ${pend.length ? pend.map(item).join('') : '<p class="muted center">Nada pendente. 👍</p>'}
    ${futuros.length ? `<h2>Próximos</h2>${futuros.map(item).join('')}` : ''}`;
}

/* -------------------------------------------------------------- aba: painel */

function abaPainel() {
  const R = state.registros;
  const h = hojeISO(), sem = diasAtras(7);
  const conta = (campo) => R.reduce((a, r) => { const k = r[campo] || '—'; a[k] = (a[k] || 0) + 1; return a; }, {});

  const barras = (obj, ordem) => {
    const max = Math.max(1, ...Object.values(obj));
    const chaves = ordem ? ordem.filter((k) => obj[k]) : Object.keys(obj).sort((a, b) => obj[b] - obj[a]);
    return chaves.map((k) => `<div class="barra">
      <div class="barra-l">${esc(k)}</div>
      <div class="barra-t"><div class="barra-f" style="width:${(obj[k] / max) * 100}%"></div></div>
      <div class="barra-n">${obj[k]}</div>
    </div>`).join('');
  };

  const abertos = R.filter((r) => CONFIG.STATUS_ABERTOS.includes(r.status)).length;
  const porUf = conta('uf');
  const topUf = Object.fromEntries(Object.entries(porUf).sort((a, b) => b[1] - a[1]).slice(0, 6));

  return `
    <div class="kpis">
      <div class="kpi"><div class="kpi-n">${R.length}</div><div class="kpi-l">empresas na base</div></div>
      <div class="kpi"><div class="kpi-n">${abertos}</div><div class="kpi-l">em aberto</div></div>
      <div class="kpi"><div class="kpi-n">${R.filter((r) => r.data_contato === h).length}</div><div class="kpi-l">contatos hoje</div></div>
      <div class="kpi"><div class="kpi-n">${R.filter((r) => r.data_contato >= sem).length}</div><div class="kpi-l">últimos 7 dias</div></div>
    </div>
    <h2>Funil</h2>${barras(conta('status'), CONFIG.STATUSES)}
    <h2>Categoria</h2>${barras(conta('categoria'))}
    <h2>Estados</h2>${barras(topUf)}
    <h2>Por responsável</h2>${barras(conta('responsavel'))}`;
}

/* ---------------------------------------------------------------- formulário */

function formulario(r) {
  const novo = !r.id;
  const v = (k, d = '') => esc(r[k] ?? d);
  const opts = (arr, sel) => arr.map((o) => `<option value="${esc(o)}"${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');
  const empresas = [...new Set(state.registros.map((x) => x.empresa).filter(Boolean))].slice(0, 400);

  return `<div class="sheet-bg" data-acao="fechar-fundo"><div class="sheet">
    <h3>${novo ? 'Novo contato' : 'Editar'}</h3>
    <form id="form">
      <label>Empresa</label>
      <input name="empresa" required value="${v('empresa')}" list="empresas" autocomplete="off">
      <datalist id="empresas">${empresas.map((e) => `<option value="${esc(e)}">`).join('')}</datalist>

      <label>WhatsApp / Telefone</label>
      <input name="telefone" value="${v('telefone')}" inputmode="tel">

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px">
        <div><label>Cidade</label><input name="cidade" value="${v('cidade')}"></div>
        <div><label>UF</label><input name="uf" value="${v('uf')}" maxlength="12"></div>
      </div>

      <label>E-mail</label><input name="email" type="email" value="${v('email')}" inputmode="email">
      <label>Site</label><input name="site" value="${v('site')}" inputmode="url">

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>Categoria</label><select name="categoria">${opts(CONFIG.CATEGORIAS, r.categoria || 'Construtora')}</select></div>
        <div><label>Status</label><select name="status">${opts(CONFIG.STATUSES, r.status || 'Contatado')}</select></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>Data do contato</label><input name="data_contato" type="date" value="${v('data_contato', novo ? hojeISO() : '')}"></div>
        <div><label>Próximo passo</label><input name="proximo_passo" type="date" value="${v('proximo_passo')}"></div>
      </div>

      <label>Notas</label><textarea name="notas">${v('notas')}</textarea>

      <div class="sheet-acoes">
        <button type="button" data-acao="fechar">Cancelar</button>
        <button type="submit" class="btn-primary">Salvar</button>
      </div>
      ${novo ? '' : '<button type="button" class="btn-danger" data-acao="apagar" data-id="' + esc(r.id) + '" style="width:100%;margin-top:8px">Apagar registro</button>'}
    </form>
  </div></div>`;
}

/* -------------------------------------------------------------------- ações */

document.addEventListener('click', async (ev) => {
  const alvo = ev.target.closest('[data-acao]');
  if (!alvo) return;
  const acao = alvo.dataset.acao;

  // Deixa passar os links de verdade (WhatsApp, tel:, mailto:, site).
  if (alvo.tagName === 'A' && !['editar', 'sair', 'fechar'].includes(acao)) return;
  ev.preventDefault();

  const acoes = {
    'recarregar-pagina': () => location.reload(),

    entrar: async () => {
      try { await auth.signIn(); await carregar(); } catch (e) { erro(e); }
    },

    sair: () => { auth.signOut(); state.registros = []; state.pronto = false; render(); },

    tab: () => { state.tab = alvo.dataset.tab; state.limite = 60; render(); },

    mais: () => { state.limite += 60; render(); },

    novo: () => { state.editando = {}; render(); },

    editar: () => {
      state.editando = state.registros.find((r) => r.id === alvo.dataset.id) || {};
      render();
    },

    fechar: () => { state.editando = null; render(); },

    'fechar-fundo': () => {
      if (ev.target.classList.contains('sheet-bg')) { state.editando = null; render(); }
    },

    feito: async () => {
      alvo.disabled = true;
      try {
        await sheets.update(alvo.dataset.id, { feito: 'sim' });
        toast('Marcado como feito.');
        await recarregar();
      } catch (e) { erro(e); alvo.disabled = false; }
    },

    apagar: async () => {
      if (!confirm('Apagar este registro da planilha?')) return;
      alvo.disabled = true;
      try {
        await sheets.remove(alvo.dataset.id);
        state.editando = null;
        toast('Registro apagado.');
        await recarregar();
      } catch (e) { erro(e); alvo.disabled = false; }
    },

    'dry-run': async () => {
      alvo.disabled = true;
      alvo.textContent = 'Lendo a planilha…';
      try {
        state.migracao = await migrate.dryRun();
      } catch (e) { erro(e); }
      render();
    },

    'migrar-cancelar': () => { state.migracao = null; render(); },

    'migrar-confirmar': async () => {
      alvo.disabled = true;
      alvo.textContent = 'Gravando…';
      try {
        const n = await migrate.commit(state.migracao.registros, auth.getUserEmail());
        state.migracao = null;
        toast(`${n} registros importados.`);
        await carregar();
      } catch (e) { erro(e); render(); }
    },
  };

  await acoes[acao]?.();
});

document.addEventListener('input', (ev) => {
  const acao = ev.target.dataset.acao;
  if (acao === 'busca') {
    state.busca = ev.target.value;
    state.limite = 60;
    // Re-renderiza só a lista para não perder o foco do campo de busca.
    const main = document.querySelector('main');
    if (main) main.innerHTML = abaLista();
    const inp = document.querySelector('[data-acao="busca"]');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
});

document.addEventListener('change', (ev) => {
  const acao = ev.target.dataset.acao;
  if (acao === 'f-status') { state.fStatus = ev.target.value; state.limite = 60; render(); }
  if (acao === 'f-categoria') { state.fCategoria = ev.target.value; state.limite = 60; render(); }
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'form') return;
  ev.preventDefault();

  const btn = ev.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Salvando…';

  const dados = Object.fromEntries(new FormData(ev.target));
  const atual = state.editando;

  try {
    if (atual.id) {
      await sheets.update(atual.id, dados);
      toast('Alterações salvas.');
    } else {
      await sheets.create({ ...dados, responsavel: auth.getUserEmail() || '', feito: '' });
      toast('Contato registrado.');
    }
    state.editando = null;
    await recarregar();
  } catch (e) {
    erro(e);
    btn.disabled = false;
    btn.textContent = 'Salvar';
  }
});

/* ------------------------------------------------------------------- início */

// O listener só repinta. Quem dispara a carga é o boot (abaixo) ou a ação
// "entrar" — se ele também chamasse carregar(), a carga rodaria sem ser
// aguardada e o boot zeraria `carregando` no meio dela, piscando a tela vazia.
auth.onAuthChange(() => render());

(async () => {
  try {
    await auth.init();
    if (auth.isSignedIn()) return void (await carregar());
  } catch (e) {
    state.erroFatal = e.message;
  }
  state.carregando = false;
  render();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* PWA é opcional */ });
}
