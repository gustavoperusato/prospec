# Prospecção — PWA estático ligado à planilha do Google

App mobile-first, sem backend, que lê e escreve direto numa planilha do Google
usando a conta Google de quem está usando. Hospedagem: GitHub Pages.

Nenhum servidor, nenhum banco, nenhum segredo no código.

---

## Como funciona

```
celular  ──OAuth──►  Google Identity Services  ──access token──┐
   │                                                            ▼
   └────────── fetch com Bearer ──────────────►  Sheets API v4 ──► planilha
```

O app age **em nome de quem está logado**. Quem controla o acesso é o
compartilhamento da planilha no Google Drive — não o app. Se você remover o
acesso de alguém no Drive, o app daquela pessoa para de funcionar sozinho.

O `CLIENT_ID` que fica em `config.js` é **público por design**: este é um
"cliente público" OAuth, que não tem client secret. Não é um vazamento.

---

## Configuração (uma vez, ~10 min)

### 1. Google Cloud

1. [console.cloud.google.com](https://console.cloud.google.com) → criar projeto.
2. **APIs e serviços → Biblioteca** → ativar **Google Sheets API**.
3. **Tela de consentimento OAuth** → tipo **External** → status **Testing**.
4. Em **Test users**, adicionar seu e-mail e o do seu amigo.
   Em Testing, com até 100 usuários, **o Google não exige verificação do app**.
   É isso que evita semanas de espera por review.
5. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**.
6. Em **Origens JavaScript autorizadas**, adicionar as duas:
   - `https://SEUUSUARIO.github.io`
   - `https://prospec.SEUDOMINIO.com.br`
7. Copiar o Client ID para o campo `CLIENT_ID` em [`config.js`](./config.js).

> **`file://` não funciona.** O Google não aceita `file://` como origem. Abrir o
> `index.html` com duplo clique nunca vai autenticar — tem que ser pela URL https.

### 2. GitHub Pages

Copie esta pasta para um repositório dedicado (ex.: `prospeccao-app`) e ligue o
Pages nele.

> **Por que um repo só para isso:** no GitHub Pages o domínio personalizado é
> **1:1 com o repositório**. Se você apontar seu domínio para um repo que já tem
> outra finalidade, aquele domínio fica preso lá.

**Settings → Pages** → Source: branch `main`, pasta `/ (root)`.

### 3. Domínio personalizado

1. Criar um arquivo `CNAME` na raiz do repo, com uma linha:
   ```
   prospec.SEUDOMINIO.com.br
   ```
2. No DNS do domínio — **subdomínio é bem mais simples que apex**:
   ```
   CNAME   prospec   SEUUSUARIO.github.io
   ```
   (Se fizer questão do apex, são 4 registros A: `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.)
3. **Settings → Pages → Custom domain** → preencher → marcar **Enforce HTTPS**.
   O certificado (Let's Encrypt, grátis) costuma sair em minutos; pode levar 24h.

### 4. Primeiro acesso

Abrir a URL no celular → **Entrar com Google** → o app oferece importar as
empresas que já estão na planilha.

---

## A migração

Na primeira vez, o app cria a aba **`Dados`** e oferece importar o conteúdo da
aba original.

**A aba original nunca é escrita.** Ela é só lida. Por isso a migração é sempre
refazível: apague a aba `Dados` e rode de novo.

Antes de gravar, o app mostra um **relatório de conferência** (dry-run) com quantos
registros caem em cada status e categoria, e quantas linhas ele ignorou. Nada é
escrito até você confirmar.

### O que a migração extrai

A aba original não é uma tabela — são várias sub-tabelas numa aba só, com linhas
mescladas de seção no meio e **dois cabeçalhos diferentes** (um de 7 e um de 8
colunas). O status e a data estavam escritos em prosa na coluna `Observação`.

| Na planilha original | Vira |
|---|---|
| `Contato feito 20/08` | `status = Contatado`, `data_contato = 2026-08-20` |
| `Nova (13/08)` | `status = Nova` (a data ali é de inclusão, não de contato) |
| `Já contatada — não localizada` | `status = Contatado`, resto vai para `notas` |
| Descrição livre do negócio | `status = Nova`, texto inteiro para `notas` |
| Seção `A CONTATAR` / `PPCI` / `VENCEDORAS` | `categoria` |

A data só é aceita **logo depois do marcador de status**. Um `\d+/\d+` solto
capturaria lixo — a base tem `Contrato nº 66/2025`, que viraria "66/20".

Duas particularidades tratadas:

- **Telefone com dois números** (Aurora Coop, Eliane, Menegotti, SCGÁS). O app
  detecta pela contagem de dígitos e junta com `/`, funcionando tanto se forem
  duas células quanto uma célula com quebra de linha.
- **Bloco PPCI tem 8 colunas** (`Setor / Observação` + `Portal/Canal
  Fornecedores`). A coluna extra é anexada às `notas`.

---

## A aba `Dados`

| Coluna | Observação |
|---|---|
| `id` | UUID estável. **Nunca editar à mão** — é por ele que o app acha a linha |
| `empresa`, `telefone`, `cidade`, `uf`, `email`, `site` | dados de contato |
| `categoria` | Construtora / Indústria PPCI / Licitação 2026 / Licitação anterior |
| `status` | Nova → Contatado → Respondeu → Reunião → Proposta → Fechado / Perdido |
| `data_contato` | alimenta "contatos hoje" e o painel |
| `proximo_passo` + `feito` | alimentam a aba Follow-ups |
| `notas` | texto livre |
| `responsavel` | preenchido sozinho com o e-mail de quem registrou |
| `criado_em`, `atualizado_em` | ISO, automáticos |

Editar a aba `Dados` direto no Google Sheets funciona normalmente — só não mexa
na coluna `id`.

---

## Detalhes de implementação que importam

**Escrita usa `valueInputOption=RAW`, não `USER_ENTERED`.** Os telefones começam
com `+` (`+55 54 3224-5444`). Com `USER_ENTERED` o Sheets interpreta um valor
iniciado por `+` como **fórmula** e grava `#ERROR!` na célula. Com `RAW` tudo é
guardado literalmente. Efeito colateral aceito: as datas ficam como texto ISO
(`2026-09-02`), que continua ordenando certo.

**Toda escrita é resolvida pelo `id`, nunca por índice de linha guardado.** Antes
de editar ou apagar, o app relê a aba e localiza a linha pelo `id` — porque o
índice desloca quando a outra pessoa insere ou apaga algo.

**Renovação de token é invisível.** O access token dura ~1h. Qualquer 401 dispara
uma renovação silenciosa e repete a chamada uma vez.

---

## Limitações conhecidas

- **Concorrência não é atômica.** A sequência é ler → achar pelo `id` → escrever,
  com uma janela de ~200ms. Se duas pessoas salvarem *a mesma linha* no mesmo
  instante, a última vence. Com duas pessoas é aceitável; trava de verdade
  exigiria Apps Script com `LockService`.
- **Sem offline.** O service worker existe só para o app ser instalável — não
  guarda cache. Sem internet, o app abre e não carrega dados.
- **O escopo `spreadsheets` dá acesso a todas as suas planilhas**, não só a esta.
  A alternativa restrita (`drive.file`) exigiria integrar o Google Picker.
- **Modo Testing pode pedir consentimento de novo** de tempos em tempos.

---

## Se o login travar no iPhone

O login do Google abre um **popup**. Dentro de um PWA instalado no iOS, popup e
armazenamento se comportam diferente do Safari, e o login pode não concluir.

Saídas, em ordem:

1. Trocar `"display": "standalone"` por `"display": "browser"` no
   [`manifest.webmanifest`](./manifest.webmanifest) — continua indo para a tela de
   início, mas abre no Safari.
2. Usar no Android, onde o fluxo funciona bem.
3. Migrar para um web app do Apps Script (perde o PWA e fica mais lento).

Não adianta trocar por `initCodeClient` com redirect: aquilo devolve um
*authorization code*, cuja troca por token exige client secret — ou seja, um
backend, que é justamente o que este projeto não tem.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `config.js` | **o único que você precisa editar** — Client ID e ID da planilha |
| `auth.js` | OAuth: token, renovação silenciosa, identidade |
| `sheets.js` | Sheets API v4: ler, criar, editar, apagar |
| `migrate.js` | importação única da aba original (dry-run + gravação) |
| `app.js` | as 4 abas e o formulário |
| `styles.css` | mobile-first, tema claro e escuro |
| `sw.js` | service worker mínimo, sem cache |
