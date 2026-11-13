'use strict';
const e = process.env;

const config = {
  producao: e.NODE_ENV === 'production',
  porta: Number(e.PORT) || 3000,
  // No Railway, o domínio público vem em RAILWAY_PUBLIC_DOMAIN; no Vercel, em VERCEL_PROJECT_PRODUCTION_URL
  vercel: !!e.VERCEL,
  baseUrl: (e.BASE_URL
    || (e.RAILWAY_PUBLIC_DOMAIN ? 'https://' + e.RAILWAY_PUBLIC_DOMAIN : '')
    || (e.VERCEL ? 'https://' + (e.VERCEL_PROJECT_PRODUCTION_URL || e.VERCEL_URL) : '')
    || 'http://localhost:3000').replace(/\/$/, ''),
  trustProxy: e.TRUST_PROXY === 'true' || ((!!e.RAILWAY_ENVIRONMENT || !!e.VERCEL) && e.TRUST_PROXY !== 'false'),
  // O banco criado pelo Vercel (Neon) entrega DATABASE_URL; POSTGRES_URL fica como alternativa
  databaseUrl: e.DATABASE_URL || e.POSTGRES_URL,
  databaseSsl: e.DATABASE_SSL === 'true',
  sessionSecret: e.SESSION_SECRET || '', // vazio = gerado e guardado no banco na primeira inicialização
  sessaoHoras: Number(e.SESSAO_HORAS) || 8,

  // "local" (e-mail e senha, padrão), "entra" (Microsoft Entra ID) ou "dev" (sem senha, só testes)
  authMode: (e.AUTH_MODE || 'local').toLowerCase(),
  local: {
    adminEmail: (e.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminSenhaInicial: e.ADMIN_SENHA_INICIAL || '',
    adminNome: e.ADMIN_NOME || 'Administrador',
  },
  entra: {
    tenantId: e.ENTRA_TENANT_ID,
    clientId: e.ENTRA_CLIENT_ID,
    clientSecret: e.ENTRA_CLIENT_SECRET,
    // Perfis: primeiro pelas App Roles do aplicativo (Admin, Analista, Leitura);
    // se não houver, pelos IDs de grupo abaixo.
    grupoAdmin: e.ENTRA_GRUPO_ADMIN || '',
    grupoAnalista: e.ENTRA_GRUPO_ANALISTA || '',
    grupoLeitura: e.ENTRA_GRUPO_LEITURA || '',
    // true = quem não tiver nenhum perfil atribuído é bloqueado
    exigirPerfil: e.ENTRA_EXIGIR_PERFIL !== 'false',
  },
  dev: {
    nome: e.DEV_USUARIO_NOME || 'Usuário de teste',
    perfil: e.DEV_USUARIO_PERFIL || 'Admin',
  },

  // "banco" (padrão: arquivos de evidência ficam no PostgreSQL) ou "disco" (pasta UPLOAD_DIR)
  armazenamento: (e.ARMAZENAMENTO || 'banco').toLowerCase(),
  uploadDir: e.UPLOAD_DIR || './uploads',
  importarPiloto: e.IMPORTAR_DADOS_PILOTO === 'true',
  // No Vercel o corpo de cada requisição é limitado a 4,5 MB
  maxUploadMb: Number(e.MAX_UPLOAD_MB) || (e.VERCEL ? 4 : 20),

  captura: {
    ativa: e.CAPTURA_ATIVA !== 'false',
    cron: e.CAPTURA_CRON || '35 7 * * *',
    fusoHorario: e.CAPTURA_FUSO || 'America/Sao_Paulo',
    // A ANBIMA precisa do Chromium, que não roda no Vercel (lá ela fica a cargo do GitHub Actions)
    anbima: e.CAPTURA_ANBIMA ? e.CAPTURA_ANBIMA !== 'false' : !e.VERCEL,
    dataInicial: e.CAPTURA_DATA_INICIAL || '', // AAAA-MM-DD da primeira execução, se o banco estiver vazio
    // Vercel Cron: chama /api/cron/captura com o cabeçalho Authorization: Bearer CRON_SECRET
    cronSecret: e.CRON_SECRET || '',
  },
};

function validar() {
  const faltando = [];
  if (!config.databaseUrl) faltando.push('DATABASE_URL');
  if (config.sessionSecret && config.sessionSecret.length < 32) faltando.push('SESSION_SECRET com no mínimo 32 caracteres (ou deixe vazio para gerar automaticamente)');
  if (config.authMode === 'entra') {
    for (const k of ['tenantId', 'clientId', 'clientSecret']) {
      if (!config.entra[k]) faltando.push('ENTRA_' + k.replace(/[A-Z]/g, m => '_' + m).toUpperCase());
    }
  } else if (config.authMode === 'dev') {
    if (config.producao) throw new Error('AUTH_MODE=dev não é permitido com NODE_ENV=production.');
  } else if (config.authMode === 'local') {
    if (config.local.adminSenhaInicial && config.local.adminSenhaInicial.length < 10) faltando.push('ADMIN_SENHA_INICIAL com no mínimo 10 caracteres');
  } else {
    throw new Error('AUTH_MODE deve ser "local", "entra" ou "dev".');
  }
  if (!['banco', 'disco'].includes(config.armazenamento)) faltando.push('ARMAZENAMENTO = banco ou disco');
  if (faltando.length) throw new Error('Variáveis de ambiente obrigatórias ausentes: ' + faltando.join(', '));
}

module.exports = { config, validar };
