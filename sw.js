// Service worker mínimo: existe apenas para o navegador considerar o app
// instalável. NÃO faz cache — a escolha foi "sem offline nenhum", então toda
// requisição vai direto para a rede.
//
// Se um dia quiser offline, é aqui que entra — mas aí vem junto o problema de
// conflito de escrita entre duas pessoas.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough: sem cache */ });
