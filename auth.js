// OAuth do Google 100% no browser, via Google Identity Services (GIS).
//
// Modelo de token: o app pede um access token direto ao Google e o usa como
// Bearer nas chamadas da Sheets API. Não há client secret e não há refresh
// token — o token dura ~1h e é renovado silenciosamente com prompt:''.

import { CONFIG } from './config.js';

const CONSENT_FLAG = 'prospeccao.consentiu';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;       // epoch ms
let userEmail = null;
let waiters = [];          // resolvers da requisição de token em voo

const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const state = { signedIn: !!accessToken, email: userEmail };
  for (const fn of listeners) fn(state);
}

// localStorage pode lançar (janela privada, site data bloqueado). Nunca deixar
// isso derrubar o app: a flag é só uma dica de UX.
const flag = {
  get() { try { return localStorage.getItem(CONSENT_FLAG) === '1'; } catch { return false; } },
  set() { try { localStorage.setItem(CONSENT_FLAG, '1'); } catch { /* ignora */ } },
  clear() { try { localStorage.removeItem(CONSENT_FLAG); } catch { /* ignora */ } },
};

/** Espera o script do GIS terminar de carregar. */
function waitForGis(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error('Não consegui carregar o Google Identity Services. Verifique a conexão.'));
      }
      setTimeout(poll, 50);
    })();
  });
}

export async function init() {
  await waitForGis();

  if (CONFIG.CLIENT_ID.startsWith('PREENCHA')) {
    throw new Error(
      'CLIENT_ID não configurado. Abra prospeccao/config.js e preencha o Client ID ' +
      'criado no Google Cloud (ver README.md).'
    );
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: (resp) => {
      if (resp.error) return settle(new Error(describeError(resp.error)));
      accessToken = resp.access_token;
      // expires_in vem em segundos; guardo 60s de margem.
      tokenExpiry = Date.now() + ((Number(resp.expires_in) || 3600) - 60) * 1000;
      flag.set();
      settle(null);
    },
    error_callback: (err) => settle(new Error(describeError(err?.type || err?.message))),
  });

  // Só tenta o login silencioso se este navegador já consentiu alguma vez.
  //
  // Sem essa guarda, a primeira visita chamaria requestAccessToken fora de um
  // gesto do usuário — e como não há consentimento prévio, o GIS tentaria abrir
  // o popup de consentimento, que o navegador bloqueia. Na primeira visita a
  // tela de login (com botão) é quem dispara o fluxo.
  if (flag.get()) {
    try {
      await requestToken();
      await loadUserEmail();
    } catch {
      // Sessão Google expirou ou consentimento foi revogado: cai na tela de login.
      flag.clear();
    }
  }
  emit();
}

function settle(err) {
  const pend = waiters;
  waiters = [];
  for (const { resolve, reject } of pend) err ? reject(err) : resolve(accessToken);
}

function describeError(code) {
  switch (code) {
    case 'popup_closed':
      return 'Janela do Google fechada antes de concluir o login.';
    case 'popup_failed_to_open':
      return 'O navegador bloqueou a janela do Google. Se estiver no app instalado ' +
             'do iPhone, tente abrir pelo Safari.';
    case 'access_denied':
      return 'Acesso negado. Confirme que seu e-mail está na lista de test users ' +
             'do projeto no Google Cloud.';
    default:
      return `Falha na autenticação${code ? ` (${code})` : ''}.`;
  }
}

/**
 * Pede um access token. Chamadas concorrentes compartilham a mesma requisição.
 * prompt:'' = não mostra nada se o consentimento já existe; mostra o popup
 * quando é a primeira vez (por isso signIn() é sempre disparado por clique).
 */
function requestToken() {
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    if (waiters.length === 1) tokenClient.requestAccessToken({ prompt: '' });
  });
}

/** Login explícito, disparado por clique do usuário (permite abrir popup). */
export async function signIn() {
  await requestToken();
  await loadUserEmail();
  emit();
}

export function signOut() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  tokenExpiry = 0;
  userEmail = null;
  flag.clear();
  emit();
}

/** Token válido, renovando silenciosamente se estiver perto de expirar. */
export async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return requestToken();
}

/** Força renovação — usado pelo retry de 401 em sheets.js. */
export async function refreshToken() {
  accessToken = null;
  tokenExpiry = 0;
  return requestToken();
}

export function isSignedIn() { return !!accessToken; }
export function getUserEmail() { return userEmail; }

async function loadUserEmail() {
  if (!accessToken) return;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) userEmail = (await r.json()).email || null;
  } catch {
    // Identidade é conveniência (coluna "responsavel"), não bloqueia o app.
  }
}
