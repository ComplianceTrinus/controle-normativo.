'use strict';
// Sugestão de análise pelo Microsoft 365 Copilot (Chat API da Microsoft, ainda em versão beta).
// O login do sistema continua o mesmo: cada pessoa do Compliance conecta a própria conta Microsoft
// uma vez, e o acesso fica guardado só na sessão do servidor. A sugestão nunca é salva sozinha:
// quem analisa revisa, aplica na ficha e salva. Cada pedido fica na trilha de auditoria.
// Configuração (feita pela TI): ENTRA_TENANT_ID, ENTRA_CLIENT_ID e ENTRA_CLIENT_SECRET na Vercel,
// com o endereço de retorno <BASE_URL>/ms/retorno registrado no aplicativo do Entra.
const crypto = require('crypto');
const express = require('express');
const { config } = require('./config');
const { q } = require('./db');
const { registrarAuditoria, listarAreas } = require('./colecoes');

const router = express.Router();
const GRAPH = 'https://graph.microsoft.com';
// Permissões exigidas pela Microsoft para a Chat API do Copilot (todas delegadas)
const ESCOPOS = ['Sites.Read.All', 'Mail.Read', 'People.Read.All', 'OnlineMeetingTranscript.Read.All', 'Chat.Read', 'ChannelMessage.Read.All', 'ExternalItem.Read.All']
  .map(s => `${GRAPH}/${s}`).concat(['offline_access']);

const configurado = () => !!(config.entra.tenantId && config.entra.clientId && config.entra.clientSecret);
const redirectUri = () => `${config.baseUrl}/ms/retorno`;
const podeUsar = req => ['Admin', 'Analista'].includes(req.session.usuario && req.session.usuario.perfil);

// Um cliente por requisição, com o cache de tokens da própria sessão (funciona em várias instâncias)
function cliente(req) {
  const msal = require('@azure/msal-node');
  const c = new msal.ConfidentialClientApplication({
    auth: { clientId: config.entra.clientId, authority: `https://login.microsoftonline.com/${config.entra.tenantId}`, clientSecret: config.entra.clientSecret },
  });
  if (req.session.msCache) c.getTokenCache().deserialize(req.session.msCache);
  return { c, msal };
}
async function token(req) {
  if (!req.session.msCache || !req.session.msConta) return null;
  const { c } = cliente(req);
  const contas = await c.getTokenCache().getAllAccounts();
  const conta = contas.find(a => a.homeAccountId === req.session.msConta.homeAccountId) || contas[0];
  if (!conta) return null;
  try {
    const r = await c.acquireTokenSilent({ account: conta, scopes: ESCOPOS });
    req.session.msCache = c.getTokenCache().serialize();
    return r && r.accessToken;
  } catch { return null; }
}

router.get('/ms/conectar', async (req, res, next) => {
  try {
    if (!configurado()) return res.status(400).send('A integração com o Microsoft 365 Copilot ainda não foi configurada pela TI.');
    if (!podeUsar(req)) return res.status(403).send('Somente o Compliance usa a sugestão do Copilot.');
    const { c, msal } = cliente(req);
    const pkce = await new msal.CryptoProvider().generatePkceCodes();
    const state = crypto.randomBytes(16).toString('hex');
    const volta = /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(String(req.query.norma || '')) ? String(req.query.norma) : '';
    req.session.msOauth = { state, verifier: pkce.verifier, volta };
    const url = await c.getAuthCodeUrl({ scopes: ESCOPOS, redirectUri: redirectUri(), codeChallenge: pkce.challenge, codeChallengeMethod: 'S256', state, prompt: 'select_account' });
    req.session.save(() => res.redirect(url));
  } catch (e) { next(e); }
});

router.get('/ms/retorno', async (req, res, next) => {
  try {
    const o = req.session.msOauth;
    if (!o || !req.query.state || req.query.state !== o.state) return res.status(400).send('A conexão com a Microsoft expirou. Volte ao sistema e tente de novo.');
    delete req.session.msOauth;
    if (req.query.error) return res.status(400).send('A Microsoft não autorizou a conexão: ' + String(req.query.error_description || req.query.error).slice(0, 300));
    const { c } = cliente(req);
    const r = await c.acquireTokenByCode({ code: String(req.query.code || ''), scopes: ESCOPOS, redirectUri: redirectUri(), codeVerifier: o.verifier });
    req.session.msCache = c.getTokenCache().serialize();
    req.session.msConta = { homeAccountId: r.account.homeAccountId, username: r.account.username };
    await registrarAuditoria({ acao: 'Conectou', tipo: 'Usuário', ref: r.account.username, detalhe: 'Conta Microsoft conectada para a sugestão do Copilot' }, req.session.usuario.id);
    req.session.save(() => res.redirect(o.volta ? '/?norma=' + encodeURIComponent(o.volta) : '/#normas'));
  } catch (e) { next(e); }
});

router.get('/api/copilot/status', (req, res) => {
  res.json({ configurado: configurado(), podeUsar: podeUsar(req), conectado: !!req.session.msConta, conta: req.session.msConta ? req.session.msConta.username : '' });
});

router.post('/api/copilot/desconectar', (req, res) => {
  delete req.session.msCache; delete req.session.msConta;
  req.session.save(() => res.json({ ok: true }));
});

const cite = n => `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;

function montarPedido(n, areas) {
  const inst = (process.env.IA_PERFIL_INSTITUICAO || 'Grupo Trinus, com instituições reguladas pelo Banco Central do Brasil e pela CVM').trim();
  return `Você é analista de Compliance da instituição: ${inst}.
Avalie a norma abaixo para a nossa instituição. Consulte as nossas políticas e normas internas (SharePoint e arquivos da empresa) antes de responder.

Norma: ${cite(n)}${n.data ? ` (publicada em ${n.data})` : ''}
Ementa: ${n.ementa}
${n.link ? `Texto oficial: ${n.link}` : ''}

Áreas da instituição (use só estes nomes): ${areas.join(', ')}.

Responda SOMENTE com um bloco JSON, sem texto antes ou depois, neste formato:
{"aplicavel":"Sim ou Não","justificativa":"até 4 linhas","areas":["..."],"risco":"Alta, Média ou Baixa","riscoMotivo":"1 linha","envioRegulador":"Sim ou Não","atualizaPolitica":"Sim ou Não","politicas":["nome das políticas internas afetadas"],"oQueMuda":"até 3 linhas","fontes":["documentos internos consultados"]}`;
}

function extrairJson(txt) {
  const t = String(txt || '');
  const bloco = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = bloco ? bloco[1] : (t.match(/\{[\s\S]*\}/) || [''])[0];
  try { return JSON.parse(cand); } catch { return null; }
}
const nz = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const um = (v, ok, pad = '') => (ok.find(x => nz(v).startsWith(nz(x).slice(0, 3))) || pad);

async function graph(tk, caminho, corpo) {
  const r = await fetch(GRAPH + caminho, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error.code)) || ('HTTP ' + r.status);
    const e = new Error(r.status === 403 ? 'A Microsoft recusou o acesso ao Copilot (verifique a licença e as permissões com a TI): ' + msg : 'O Copilot não respondeu: ' + msg);
    e.status = r.status === 401 ? 401 : 502; throw e;
  }
  return j;
}

router.post('/api/copilot/sugerir', async (req, res) => {
  try {
    if (!configurado()) return res.status(400).json({ erro: 'A integração com o Copilot ainda não foi configurada pela TI.' });
    if (!podeUsar(req)) return res.status(403).json({ erro: 'Somente o Compliance usa a sugestão do Copilot.' });
    const id = String((req.body && req.body.normaId) || '');
    const n = (await q("SELECT id, orgao, tipo, numero, ementa, link, to_char(data_publicacao, 'DD/MM/YYYY') AS data FROM normas WHERE id = $1 AND excluido_em IS NULL", [id])).rows[0];
    if (!n) return res.status(404).json({ erro: 'Norma não encontrada.' });
    const tk = await token(req);
    if (!tk) return res.status(401).json({ erro: 'Conecte a sua conta Microsoft para usar o Copilot.', conectar: true });
    const conv = await graph(tk, '/beta/copilot/conversations', {});
    const r = await graph(tk, `/beta/copilot/conversations/${encodeURIComponent(conv.id)}/chat`, {
      message: { text: montarPedido(n, await listarAreas()) },
      locationHint: { timeZone: 'America/Sao_Paulo' },
    });
    const msgs = Array.isArray(r.messages) ? r.messages : [];
    const resp = msgs[msgs.length - 1] || {};
    const texto = String(resp.text || '').trim();
    const j = extrairJson(texto) || {};
    const areas = await listarAreas();
    const sug = {
      aplicavel: um(j.aplicavel, ['Sim', 'Não']),
      justificativa: String(j.justificativa || '').slice(0, 2000),
      areas: (Array.isArray(j.areas) ? j.areas : []).map(a => areas.find(x => x.toLowerCase() === String(a).toLowerCase())).filter(Boolean),
      risco: um(j.risco, ['Alta', 'Média', 'Baixa']),
      riscoMotivo: String(j.riscoMotivo || '').slice(0, 500),
      envioRegulador: um(j.envioRegulador, ['Sim', 'Não']),
      atualizaPolitica: um(j.atualizaPolitica, ['Sim', 'Não']),
      politicas: (Array.isArray(j.politicas) ? j.politicas : []).map(String).slice(0, 10),
      oQueMuda: String(j.oQueMuda || '').slice(0, 1500),
      fontes: (Array.isArray(j.fontes) ? j.fontes : []).map(String).slice(0, 10),
    };
    const anexos = (Array.isArray(resp.attributions) ? resp.attributions : [])
      .map(a => a.providerDisplayName || a.seeMoreWebUrl || '').filter(Boolean).slice(0, 10);
    await registrarAuditoria({ acao: 'Pediu sugestão', tipo: 'Norma', ref: cite(n),
      detalhe: `Microsoft 365 Copilot · aplicável: ${sug.aplicavel || '—'} · risco: ${sug.risco || '—'} · áreas: ${sug.areas.join(', ') || '—'}` }, req.session.usuario.id);
    res.json({ sugestao: sug, texto: Object.keys(j).length ? '' : texto.slice(0, 4000), fontes: [...new Set(sug.fontes.concat(anexos))], em: new Date().toISOString() });
  } catch (e) {
    console.error('[copilot]', e.message);
    res.status(e.status === 401 ? 401 : (e.status || 500)).json({ erro: e.message, conectar: e.status === 401 });
  }
});

module.exports = { router };
