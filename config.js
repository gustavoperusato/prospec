// Configuração do app. O único valor que você precisa preencher é CLIENT_ID.
//
// O CLIENT_ID é público por design: este é um "cliente público" OAuth, sem
// client secret. Quem controla o acesso aos dados é o compartilhamento da
// planilha no Google Drive, não este arquivo.

export const CONFIG = {
  // Google Cloud → Credentials → OAuth client ID → Web application.
  // Ver README.md, seção "Google Cloud".
  CLIENT_ID: '403372754102-nvo9ikb5sjum0mrm20dukf8c7incfi6i.apps.googleusercontent.com',

  SPREADSHEET_ID: '1Y97HJI5kBE8i-R0f-pRYGqtBTlipqubl4yajGQOia9w',

  // Aba que o app é dono. Criada automaticamente no primeiro uso.
  DATA_SHEET: 'Dados',

  // spreadsheets  -> ler/escrever a planilha
  // openid email  -> descobrir quem está logado, para a coluna "responsavel"
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets openid email',

  STATUSES: ['Nova', 'Contatado', 'Respondeu', 'Reunião', 'Proposta', 'Fechado', 'Perdido'],

  // Status considerados "em aberto" para o funil do painel.
  STATUS_ABERTOS: ['Nova', 'Contatado', 'Respondeu', 'Reunião', 'Proposta'],

  CATEGORIAS: ['Construtora', 'Indústria PPCI', 'Licitação 2026', 'Licitação anterior'],

  // Ordem das colunas da aba Dados. Mudar aqui muda tudo: leitura, escrita e
  // cabeçalho são derivados desta lista.
  COLUMNS: [
    'id', 'empresa', 'telefone', 'cidade', 'uf', 'email', 'site',
    'categoria', 'status', 'data_contato', 'proximo_passo', 'feito',
    'notas', 'responsavel', 'criado_em', 'atualizado_em',
  ],
};

// 'A'..'P' — última coluna da aba Dados, derivada de COLUMNS.
export const LAST_COL = String.fromCharCode(64 + CONFIG.COLUMNS.length);
export const DATA_RANGE = `${CONFIG.DATA_SHEET}!A:${LAST_COL}`;
