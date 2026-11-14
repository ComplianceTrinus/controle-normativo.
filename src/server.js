'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const multer = require('multer');
const cron = require('node-cron');

const { config, validar } = require('./config');
const { pool, q, migrar } = require('./db');
const auth = require('./auth');
const contas = require('./contas');
const { importarBackup } = require('./importacao');
const dados = require('./colecoes');
const { executarCaptura } = require('./captura');
const { enviarResumo, statusEnvio, enviarEncaminhamento, enviarAviso } = require('./email');

validar();
if (config.armazenamento === 'disco') fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---- CSP: libera só os scripts inline da página (por hash) ----
const PUBLIC = path.join(__dirname, '..', 'public');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const hashes = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...hashes],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// A sessão é montada na inicialização (o segredo pode vir do banco).
// Toda requisição espera a inicialização terminar: no Vercel, cada instância nova passa por ela.
let middlewareSessao = null;
app.use((req, res, next) => {
  iniciar().then(() => middlewareSessao(req, res, next)).catch(err => {
    console.error('[inicialização]', err);
    res.status(503).send('O sistema não conseguiu iniciar. Tente de novo em alguns segundos.');
  });
});
const opcoesSessao = segredo => ({
  name: 'cn.sid',
  store: new PgStore({ pool, tableName: 'sessoes', createTableIfMissing: true }),
  secret: segredo,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    maxAge: config.sessaoHoras * 3600 * 1000,
  },
});

app.get('/saude', async (req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

// Captura diária disparada pelo Vercel Cron (vercel.json). O Vercel envia "Authorization: Bearer <CRON_SECRET>".
app.get('/api/cron/captura', async (req, res) => {
  const segredo = config.captura.cronSecret;
  const recebido = Buffer.from(req.get('authorization') || '');
  const esperado = Buffer.from('Bearer ' + segredo);
  if (!segredo || recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }
  try {
    const r = await rodarCaptura('agendada (Vercel Cron)');
    res.json({ ok: true, ...r });
  } catch (err) { console.error('[captura]', err); res.status(500).json({ ok: false, erro: err.message }); }
});

// Resumo diário de normas por e-mail (Vercel Cron, dias úteis às 08:xx de Brasília)
app.get('/api/cron/email', async (req, res) => {
  const segredo = config.captura.cronSecret;
  const recebido = Buffer.from(req.get('authorization') || '');
  const esperado = Buffer.from('Bearer ' + segredo);
  if (!segredo || recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }
  try { res.json({ ok: true, ...(await enviarResumo({ origem: 'agendado (Vercel Cron)' })) }); }
  catch (err) { console.error('[email]', err); res.status(err.status || 500).json({ erro: err.message }); }
});

// Link de norma vindo do e-mail: guarda por 30 min para abrir a norma depois do login
const NORMA_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const lerCookie = (req, nome) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
app.use((req, res, next) => {
  if (req.path === '/' && NORMA_ID.test(String(req.query.norma || '')) && !(req.session && req.session.usuario)) {
    res.cookie('cn_norma', String(req.query.norma), { maxAge: 30 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https://') });
  }
  next();
});
app.use(contas.router);
app.use(auth.router);
app.use(auth.exigirLogin);
app.use(contas.revalidar);
app.use(contas.exigirSenhaDefinitiva);

// Proteção contra CSRF: toda gravação vem da própria página com este cabeçalho
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ erro: 'Requisição recusada.' });
  next();
});
app.use('/api', express.json({ limit: '1mb' }));

const usuario = req => req.session.usuario;
const escrita = auth.exigirPerfil('Admin', 'Analista');
const admin = auth.exigirPerfil('Admin');
// Comentar e anexar evidência: também a Área responsável (que não altera normas, ações nem obrigações)
const colaboracao = auth.exigirPerfil('Admin', 'Analista', 'Área responsável');

// ---- Escopo da Área responsável: só ações e obrigações das suas áreas (e as normas ligadas a elas) ----
function escopoArea(req) {
  const u = usuario(req);
  if (!u || u.perfil !== 'Área responsável') return null;
  const s = new Set((u.areas || []).map(dados.normArea).filter(Boolean));
  s.verOb = !!u.verObrigacoes; // obrigações só para quem o Admin marcou
  return s;
}
async function visiveis(esc) {
  const ac = (await dados.listar('acoes')).filter(a => esc.has(dados.normArea(a.area)));
  const ob = esc.verOb ? (await dados.listar('obrigacoes')).filter(o => esc.has(dados.normArea(o.area))) : [];
  const enc = (await q('SELECT norma_id, area FROM encaminhamentos')).rows.filter(e => esc.has(dados.normArea(e.area)));
  const nIds = new Set([...ac, ...ob].map(x => x.normaId).filter(Boolean));
  enc.forEach(e => nIds.add(e.norma_id));
  return { ac, ob, acIds: new Set(ac.map(a => a.id)), nIds };
}
const COLS = ['normas', 'acoes', 'obrigacoes'];

function tratarErro(res, err) {
  if (err instanceof dados.ErroValidacao) return res.status(err.status).json({ erro: err.message });
  if (err && err.code === '23505') return res.status(409).json({ erro: 'Já existe um registro igual (norma já cadastrada).' });
  if (err && (err.code === '23514' || err.code === '22P02' || err.code === '22007' || err.code === '22008')) return res.status(400).json({ erro: 'Dado inválido: ' + err.message });
  if (err && err.code === '23503') return res.status(400).json({ erro: 'Referência inválida (a norma vinculada não existe mais).' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
}

app.get('/api/me', (req, res) => res.json({ ...usuario(req), modoLogin: config.authMode }));

app.get('/api/usuarios', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 200);
  if (!ids.length) return res.json({});
  const r = await q('SELECT id, nome FROM usuarios WHERE id = ANY($1)', [ids]);
  res.json(Object.fromEntries(r.rows.map(u => [u.id, { nome: u.nome }])));
});

app.get('/api/c/auditoria', admin, async (req, res) => {
  try { res.json(await dados.listarAuditoria(req.query.limit)); } catch (e) { tratarErro(res, e); }
});
app.post('/api/c/auditoria', escrita, async (req, res) => {
  try { await dados.registrarAuditoria(req.body || {}, usuario(req).id); res.status(201).json({ ok: true }); } catch (e) { tratarErro(res, e); }
});

app.get('/api/c/:col', async (req, res) => {
  const col = req.params.col;
  if (!COLS.includes(col)) return res.status(404).json({ erro: 'Coleção desconhecida.' });
  try {
    const esc = escopoArea(req);
    if (!esc) return res.json(await dados.listar(col));
    const v = await visiveis(esc);
    if (col === 'acoes') return res.json(v.ac);
    if (col === 'obrigacoes') return res.json(v.ob);
    res.json((await dados.listar('normas')).filter(n => v.nIds.has(n.id)));
  } catch (e) { tratarErro(res, e); }
});

// ---- Normas encaminhadas para as áreas ----
app.get('/api/encaminhamentos', async (req, res) => {
  try {
    const r = await q('SELECT id, norma_id, area, mensagem, por, em, prazo, resposta, respondido_em, respondido_por, aplicavel, impacto, plano_sugerido, data_sugerida::text AS data_sugerida FROM encaminhamentos ORDER BY em DESC LIMIT 3000');
    let l = r.rows.map(e => ({ id: e.id, normaId: e.norma_id, area: e.area, mensagem: e.mensagem || '', por: e.por, em: e.em.toISOString(), prazo: e.prazo || '', resposta: e.resposta || '', respondidoEm: e.respondido_em ? e.respondido_em.toISOString() : '', respondidoPor: e.respondido_por || null, aplicavel: e.aplicavel, impacto: e.impacto || '', planoSugerido: e.plano_sugerido || '', dataSugerida: e.data_sugerida || '' }));
    const esc = escopoArea(req);
    if (esc) l = l.filter(e => esc.has(dados.normArea(e.area)));
    res.json(l);
  } catch (e) { tratarErro(res, e); }
});
app.post('/api/normas/:id/encaminhar', escrita, async (req, res) => {
  try {
    const b = req.body || {};
    const marcadas = new Set([].concat(b.areas || []).map(dados.normArea));
    let areas = (await dados.listarAreas()).filter(a => marcadas.has(dados.normArea(a)));
    if (!areas.length) return res.status(400).json({ erro: 'Escolha pelo menos uma área.' });
    const mensagem = String(b.mensagem || '').trim().slice(0, 2000);
    const n = (await q('SELECT id, tipo, orgao, numero, ementa, link, data_publicacao FROM normas WHERE id = $1', [req.params.id])).rows[0];
    if (!n) return res.status(404).json({ erro: 'Norma não encontrada. Ela pode ter sido excluída.' });
    const quem = usuario(req);
    // Não duplica: área que ainda não respondeu esta norma não recebe de novo
    const pend = new Set((await q('SELECT area FROM encaminhamentos WHERE norma_id = $1 AND respondido_em IS NULL', [n.id])).rows.map(r => dados.normArea(r.area)));
    const repetidas = areas.filter(a => pend.has(dados.normArea(a)));
    areas = areas.filter(a => !pend.has(dados.normArea(a)));
    if (!areas.length) return res.status(409).json({ erro: `A norma já está aguardando o retorno de ${repetidas.join(', ')}.` });
    // Prazo: 10 dias corridos a partir de hoje (fuso de Brasília)
    const prazo = (await q("SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date + 10)::text AS p")).rows[0].p;
    for (const area of areas) {
      await q('INSERT INTO encaminhamentos (id, norma_id, area, mensagem, por, prazo) VALUES ($1, $2, $3, $4, $5, $6)', [crypto.randomUUID().replace(/-/g, ''), n.id, area, mensagem || null, quem.id, prazo]);
    }
    const alvo = new Set(areas.map(dados.normArea));
    const pessoas = (await q("SELECT email, areas FROM usuarios WHERE perfil = 'Área responsável' AND ativo AND email IS NOT NULL")).rows;
    const para = [...new Set(pessoas.filter(p => (p.areas || []).some(a => alvo.has(dados.normArea(a)))).map(p => p.email.toLowerCase()))];
    const envio = para.length ? await enviarEncaminhamento(para, { norma: n, areas, mensagem, por: quem.nome, prazo }) : { ok: [], falhas: [] };
    const ref = `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;
    await dados.registrarAuditoria({ acao: 'Encaminhou', tipo: 'Norma', ref, detalhe: `Para ${areas.join(', ')} · e-mail para ${envio.ok.length} pessoa(s)${envio.falhas.length ? ` · ${envio.falhas.length} falha(s)` : ''}${mensagem ? ' · ' + mensagem.slice(0, 300) : ''}` }, quem.id);
    res.json({ ok: true, areas, repetidas, prazo, avisados: envio.ok, falhas: envio.falhas, semDestinatario: !para.length });
  } catch (e) { tratarErro(res, e); }
});
// Retorno da área sobre a norma encaminhada (uma resposta; depois de enviada não muda)
app.post('/api/encaminhamentos/:id/responder', colaboracao, async (req, res) => {
  try {
    const esc = escopoArea(req);
    if (!esc) return res.status(403).json({ erro: 'Somente a área responsável registra o retorno.' });
    const b = req.body || {};
    const opc = ['sim', 'ajuste', 'nao'].includes(b.aplicavel) ? b.aplicavel : null;
    const apl = opc === null ? null : opc !== 'nao';
    const impacto = opc === 'sim' ? 'plano' : opc === 'ajuste' ? 'ajuste' : null;
    const resposta = String(b.resposta || '').trim();
    const plano = String(b.planoSugerido || '').trim();
    const data = String(b.dataSugerida || '').trim();
    const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(data);
    if (opc === null) return res.status(400).json({ erro: 'Informe se a norma é aplicável à área.' });
    if (opc === 'sim' && !plano) return res.status(400).json({ erro: 'Descreva o plano de ação sugerido.' });
    if (opc === 'sim' && !dataOk) return res.status(400).json({ erro: 'Informe a data sugerida para o plano de ação.' });
    if (opc === 'ajuste' && !plano) return res.status(400).json({ erro: 'Descreva o que muda para a área.' });
    if (opc === 'ajuste' && data && !dataOk) return res.status(400).json({ erro: 'Data prevista inválida.' });
    if (opc === 'nao' && !resposta) return res.status(400).json({ erro: 'Explique por que a norma não é aplicável.' });
    if (resposta.length > 4000 || plano.length > 4000) return res.status(400).json({ erro: 'Texto muito longo (máximo de 4.000 caracteres).' });
    const e = (await q('SELECT e.id, e.norma_id, e.area, e.respondido_em, n.tipo, n.orgao, n.numero FROM encaminhamentos e JOIN normas n ON n.id = e.norma_id WHERE e.id = $1', [req.params.id])).rows[0];
    if (!e || !esc.has(dados.normArea(e.area))) return res.status(404).json({ erro: 'Encaminhamento não encontrado.' });
    if (e.respondido_em) return res.status(409).json({ erro: 'O retorno desta área já foi enviado.' });
    // Responde de uma vez todos os encaminhamentos pendentes desta norma para a mesma área
    await q('UPDATE encaminhamentos SET resposta = $3, aplicavel = $4, plano_sugerido = $5, data_sugerida = $6, respondido_em = now(), respondido_por = $7, impacto = $8 WHERE norma_id = $1 AND area = $2 AND respondido_em IS NULL',
      [e.norma_id, e.area, resposta || null, apl, apl ? plano : null, apl && dataOk ? data : null, usuario(req).id, impacto]);
    await dados.registrarAuditoria({ acao: 'Respondeu', tipo: 'Norma', ref: `${e.tipo} ${e.orgao === 'BACEN' ? 'BCB' : e.orgao} nº ${e.numero}`, detalhe: `Retorno da área ${e.area}: ${opc === 'sim' ? 'aplicável, com plano de ação' : opc === 'ajuste' ? 'aplicável, sem plano de ação' : 'não aplicável'}${apl ? ` · ${opc === 'ajuste' ? 'o que muda' : 'plano sugerido'}: ${plano.slice(0, 300)}${dataOk ? ' · até ' + data.split('-').reverse().join('/') : ''}` : ''}${resposta ? ' · ' + resposta.slice(0, 300) : ''}` }, usuario(req).id);
    // Avisa quem encaminhou (Compliance) que a área respondeu
    try {
      const quem = (await q('SELECT DISTINCT u.email FROM encaminhamentos x JOIN usuarios u ON u.id = x.por WHERE x.norma_id = $1 AND x.area = $2 AND u.ativo AND u.email IS NOT NULL', [e.norma_id, e.area])).rows.map(r => r.email.toLowerCase());
      const ref = `${e.tipo} ${e.orgao === 'BACEN' ? 'BCB' : e.orgao} nº ${e.numero}`;
      const linhas = [['Resposta', opc === 'sim' ? 'Aplicável, com plano de ação' : opc === 'ajuste' ? 'Aplicável, sem plano de ação' : 'Não aplicável']];
      if (apl) linhas.push([opc === 'ajuste' ? 'O que muda para a área' : 'Plano de ação sugerido', plano]);
      if (dataOk) linhas.push([opc === 'ajuste' ? 'Data prevista' : 'Data sugerida', data.split('-').reverse().join('/')]);
      if (resposta) linhas.push([opc === 'nao' ? 'Justificativa' : 'Comentários', resposta]);
      linhas.push(['Respondido por', usuario(req).nome || '']);
      await enviarAviso(quem, { assunto: `Retorno da área ${e.area}: ${ref}`, titulo: `${e.area} respondeu`, subtitulo: ref, linhas, link: config.baseUrl + '/?norma=' + encodeURIComponent(e.norma_id) });
    } catch (err) { console.error('[aviso retorno]', err.message); }
    res.json({ ok: true });
  } catch (err) { tratarErro(res, err); }
});

// Lista de áreas (escolha nas ações e obrigações)
app.use('/api/admin', admin, contas.apiAdmin);
app.get('/api/areas', async (req, res) => {
  try { res.json(await dados.listarAreas()); } catch (e) { tratarErro(res, e); }
});
app.put('/api/c/:col/:id', escrita, async (req, res) => {
  try { await dados.gravar(req.params.col, req.params.id, req.body || {}, usuario(req)); res.json({ ok: true }); } catch (e) { tratarErro(res, e); }
});
app.patch('/api/c/:col/:id', escrita, async (req, res) => {
  try { await dados.atualizar(req.params.col, req.params.id, req.body || {}, usuario(req)); res.json({ ok: true }); } catch (e) { tratarErro(res, e); }
});
app.delete('/api/c/:col/:id', admin, async (req, res) => {
  try { await dados.excluir(req.params.col, req.params.id); res.json({ ok: true }); } catch (e) { tratarErro(res, e); }
});

app.get('/api/sistema/:id', async (req, res) => {
  if (!['captura', 'config'].includes(req.params.id)) return res.status(404).json({ erro: 'Não encontrado.' });
  try { res.json({ dados: await dados.lerSistema(req.params.id) }); } catch (e) { tratarErro(res, e); }
});
app.put('/api/sistema/:id', admin, async (req, res) => {
  if (req.params.id !== 'config') return res.status(403).json({ erro: 'Somente leitura.' });
  try { await dados.gravarSistema('config', req.body || {}); res.json({ ok: true }); } catch (e) { tratarErro(res, e); }
});

// ---- Destinatários do e-mail diário de normas (só o Admin vê e altera) ----
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
async function lerDestinatarios() {
  const d = await dados.lerSistema('destinatarios');
  if (d && Array.isArray(d.lista)) return { lista: d.lista, atualizadoEm: d.atualizadoEm || null };
  // Antes do primeiro cadastro, sugere o e-mail do Admin
  return { lista: config.local.adminEmail ? [{ email: config.local.adminEmail, ativo: true }] : [], atualizadoEm: null };
}
app.get('/api/admin/destinatarios', admin, async (req, res) => {
  try { res.json({ ...(await lerDestinatarios()), envio: await statusEnvio() }); } catch (e) { tratarErro(res, e); }
});
app.put('/api/admin/destinatarios', admin, async (req, res) => {
  try {
    const entrada = req.body && Array.isArray(req.body.lista) ? req.body.lista : null;
    if (!entrada) return res.status(400).json({ erro: 'Lista inválida.' });
    const vistos = new Set();
    const lista = [];
    for (const x of entrada) {
      const email = String((x && x.email) || '').trim().toLowerCase();
      if (!email) continue;
      if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ erro: 'E-mail inválido: ' + email.slice(0, 80) });
      if (vistos.has(email)) continue;
      vistos.add(email);
      lista.push({ email, ativo: !(x && x.ativo === false) });
    }
    if (lista.length > 50) return res.status(400).json({ erro: 'No máximo 50 destinatários.' });
    const antes = await lerDestinatarios();
    await dados.gravarSistema('destinatarios', { lista, atualizadoEm: new Date().toISOString(), atualizadoPor: usuario(req).id });
    const fmt = l => (l || []).map(d => d.email + (d.ativo ? '' : ' (pausado)')).join(', ') || 'nenhum';
    await dados.registrarAuditoria({ acao: 'Alterou', tipo: 'Configuração', ref: 'Destinatários do e-mail de normas', detalhe: fmt(antes.lista) + ' → ' + fmt(lista) }, usuario(req).id);
    res.json({ ok: true, lista });
  } catch (e) { tratarErro(res, e); }
});

app.post('/api/admin/email/teste', admin, async (req, res) => {
  try { res.json(await enviarResumo({ origem: 'teste manual', teste: true, usuarioId: usuario(req).id })); }
  catch (err) { console.error('[email]', err); res.status(err.status || 500).json({ erro: err.message }); }
});

let capturaRodando = false;
async function rodarCaptura(origem) {
  if (capturaRodando) return { ignorada: true };
  capturaRodando = true;
  let r = null, erro = null;
  try { r = await executarCaptura({ origem }); } catch (e) { erro = e; } finally { capturaRodando = false; }
  await alertaCaptura(r, erro).catch(e => console.error('[alerta captura]', e.message));
  if (erro) throw erro;
  return r;
}
// Alerta o Admin se a captura falhar ou passar 2 dias úteis sem encontrar normas (um aviso por dia, no máximo)
const diaSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
function diasUteisEntre(de, ate) { let n = 0; const d = new Date(de + 'T12:00:00Z'), f = new Date(ate + 'T12:00:00Z'); while (d < f) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w && w !== 6) n++; } return n; }
async function alertaCaptura(r, erro) {
  if (r && r.ignorada) return;
  const hoje = diaSP(), st = (await dados.lerSistema('alertaCaptura')) || {};
  if (r && r.novas > 0) st.ultimaComNovas = hoje;
  if (!st.ultimaComNovas) st.ultimaComNovas = hoje;
  const falhas = erro ? [erro.message] : (r && r.falhas) || [];
  const semNovas = diasUteisEntre(st.ultimaComNovas, hoje);
  const motivo = falhas.length ? 'A captura teve falhas: ' + falhas.join(' | ').slice(0, 600) : semNovas >= 2 ? `Nenhuma norma nova encontrada há ${semNovas} dias úteis (desde ${st.ultimaComNovas.split('-').reverse().join('/')}).` : '';
  if (motivo && st.ultimoAlerta !== hoje) {
    const para = (await q("SELECT email FROM usuarios WHERE perfil = 'Admin' AND ativo AND email IS NOT NULL")).rows.map(x => x.email.toLowerCase());
    await enviarAviso(para, { assunto: 'Atenção: captura automática de normas', titulo: 'Verifique a captura de normas', linhas: [['O que aconteceu', motivo], ['Fontes que responderam', r && r.fontes && r.fontes.length ? r.fontes.join(', ') : 'nenhuma']], link: config.baseUrl + '/#normas' });
    st.ultimoAlerta = hoje;
  }
  await dados.gravarSistema('alertaCaptura', st);
}
app.post('/api/captura/executar', admin, async (req, res) => {
  const execucao = rodarCaptura('manual:' + usuario(req).id);
  if (config.vercel) {
    // No Vercel a instância é congelada depois da resposta: a captura precisa terminar antes de responder
    try { await execucao; } catch (err) { console.error('[captura]', err); }
    return res.status(202).json({ ok: true, mensagem: 'Atualização concluída. Recarregue o Painel para ver o resultado.' });
  }
  execucao.catch(err => console.error('[captura]', err));
  res.status(202).json({ ok: true, mensagem: 'Atualização iniciada. O Painel mostra o resultado em alguns minutos.' });
});

// ---- Evidências ----
const TIPOS_EVIDENCIA = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
};
const upload = multer({
  storage: config.armazenamento === 'disco'
    ? multer.diskStorage({ destination: config.uploadDir, filename: (req, file, cb) => cb(null, crypto.randomUUID().replace(/-/g, '')) })
    : multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
    if (!TIPOS_EVIDENCIA[ext]) return cb(Object.assign(new Error('Formato não aceito. Use PDF, imagem, CSV ou TXT.'), { status: 415 }));
    cb(null, true);
  },
});
app.post('/api/evidencias', colaboracao, (req, res) => {
  upload.single('arquivo')(req, res, async err => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.status || 400);
      return res.status(status).json({ erro: status === 413 ? `Arquivo acima de ${config.maxUploadMb} MB.` : err.message });
    }
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const id = req.file.filename || crypto.randomUUID().replace(/-/g, '');
    const nome = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 250);
    try {
      await q('INSERT INTO evidencias (id, nome, tipo, tamanho, enviado_por, conteudo) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, nome, TIPOS_EVIDENCIA[ext], req.file.size, usuario(req).id, req.file.buffer || null]);
      res.status(201).json({ id, url: '/_blob/' + id, sizeBytes: req.file.size, contentType: TIPOS_EVIDENCIA[ext] });
    } catch (e) { if (req.file.path) fs.unlink(req.file.path, () => {}); tratarErro(res, e); }
  });
});
app.delete('/api/evidencias/:id', admin, async (req, res) => {
  const r = await q('DELETE FROM evidencias WHERE id = $1 RETURNING id', [req.params.id]);
  fs.unlink(path.join(config.uploadDir, path.basename(req.params.id)), () => {});
  res.json({ deleted: r.rowCount > 0 });
});
app.get('/_blob/:id', async (req, res) => {
  const r = await q('SELECT nome, tipo, conteudo, acao_id, enviado_por FROM evidencias WHERE id = $1', [req.params.id]);
  const ev = r.rows[0];
  const esc = ev && escopoArea(req);
  if (esc && ev.enviado_por !== usuario(req).id && !(await visiveis(esc)).acIds.has(ev.acao_id)) return res.status(404).send('Evidência não encontrada.');
  const arquivo = path.join(config.uploadDir, path.basename(req.params.id));
  if (!ev || (!ev.conteudo && !fs.existsSync(arquivo))) return res.status(404).send('Evidência não encontrada.');
  res.setHeader('Content-Type', ev.tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(ev.nome)}`);
  if (ev.conteudo) return res.end(ev.conteudo);
  fs.createReadStream(arquivo).pipe(res);
});

// Vincula evidências já enviadas a uma ação, sem alterar os demais campos (usado pela Área responsável)
const ID_ARQ = /^[A-Za-z0-9_-]{8,80}$/;
app.post('/api/acoes/:id/evidencias', colaboracao, async (req, res) => {
  try {
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).filter(x => ID_ARQ.test(x)).slice(0, 20);
    if (!ids.length) return res.status(400).json({ erro: 'Nenhuma evidência informada.' });
    const a = (await q('SELECT id, descricao FROM acoes WHERE id = $1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ erro: 'Ação não encontrada. Ela pode ter sido excluída.' });
    const esc = escopoArea(req);
    if (esc && !(await visiveis(esc)).acIds.has(a.id)) return res.status(403).json({ erro: 'Esta ação não é da sua área.' });
    const r = await q('UPDATE evidencias SET acao_id = $1 WHERE id = ANY($2) AND acao_id IS NULL AND enviado_por = $3 RETURNING nome', [a.id, ids, usuario(req).id]);
    if (!r.rowCount) return res.status(400).json({ erro: 'Nenhuma evidência pôde ser vinculada.' });
    await q('UPDATE acoes SET atualizado_em = now(), atualizado_por = $2 WHERE id = $1', [a.id, usuario(req).id]);
    await dados.registrarAuditoria({ acao: 'Anexou evidência', tipo: 'Ação', ref: String(a.descricao || '').slice(0, 80), detalhe: r.rows.map(x => x.nome).join(', ') }, usuario(req).id);
    res.json({ ok: true, vinculadas: r.rowCount });
  } catch (e) { tratarErro(res, e); }
});

// ---- Comentários em normas e ações (somente inclusão) ----
app.get('/api/comentarios', async (req, res) => {
  const normaId = String(req.query.normaId || ''), acaoId = String(req.query.acaoId || '');
  if (!normaId && !acaoId) return res.status(400).json({ erro: 'Informe a norma ou a ação.' });
  try {
    const esc = escopoArea(req);
    if (esc) {
      const v = await visiveis(esc);
      if (normaId ? !v.nIds.has(normaId) : !v.acIds.has(acaoId)) return res.status(403).json({ erro: 'Item fora da sua área.' });
    }
    const r = normaId
      ? await q('SELECT id, norma_id, acao_id, texto, por, em FROM comentarios WHERE norma_id = $1 ORDER BY em', [normaId])
      : await q('SELECT id, norma_id, acao_id, texto, por, em FROM comentarios WHERE acao_id = $1 ORDER BY em', [acaoId]);
    res.json(r.rows.map(c => ({ id: c.id, normaId: c.norma_id, acaoId: c.acao_id, texto: c.texto, por: c.por, em: c.em.toISOString() })));
  } catch (e) { tratarErro(res, e); }
});
app.post('/api/comentarios', colaboracao, async (req, res) => {
  try {
    const b = req.body || {};
    const normaId = b.normaId ? String(b.normaId) : null, acaoId = b.acaoId ? String(b.acaoId) : null;
    const texto = String(b.texto || '').trim();
    if (!normaId && !acaoId) return res.status(400).json({ erro: 'Informe a norma ou a ação.' });
    if (!texto) return res.status(400).json({ erro: 'Escreva o comentário.' });
    if (texto.length > 4000) return res.status(400).json({ erro: 'Comentário muito longo (máximo de 4.000 caracteres).' });
    const esc = escopoArea(req);
    if (esc) {
      const v = await visiveis(esc);
      if (normaId ? !v.nIds.has(normaId) : !v.acIds.has(acaoId)) return res.status(403).json({ erro: 'Item fora da sua área.' });
    }
    let ref = '';
    if (normaId) {
      const n = (await q('SELECT tipo, orgao, numero FROM normas WHERE id = $1', [normaId])).rows[0];
      if (!n) return res.status(404).json({ erro: 'Norma não encontrada. Ela pode ter sido excluída.' });
      ref = `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;
    } else {
      const a = (await q('SELECT descricao FROM acoes WHERE id = $1', [acaoId])).rows[0];
      if (!a) return res.status(404).json({ erro: 'Ação não encontrada. Ela pode ter sido excluída.' });
      ref = String(a.descricao || '').slice(0, 80);
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    await q('INSERT INTO comentarios (id, norma_id, acao_id, texto, por) VALUES ($1, $2, $3, $4, $5)', [id, normaId, acaoId, texto, usuario(req).id]);
    await dados.registrarAuditoria({ acao: 'Comentou', tipo: normaId ? 'Norma' : 'Ação', ref, detalhe: texto.slice(0, 500) }, usuario(req).id);
    res.status(201).json({ ok: true, id });
  } catch (e) { tratarErro(res, e); }
});

// ---- Página ----
app.get('/', (req, res) => {
  const pend = lerCookie(req, 'cn_norma');
  if (pend) { res.clearCookie('cn_norma'); if (!req.query.norma && NORMA_ID.test(pend)) return res.redirect('/?norma=' + encodeURIComponent(pend)); }
  res.type('html').send(indexHtml);
});
app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Erro interno.');
});

// ---- Inicialização ----
async function segredoSessao() {
  if (config.sessionSecret) return config.sessionSecret;
  // Gera uma vez e guarda no banco: sobrevive a reinícios e a novas versões
  const novo = crypto.randomBytes(48).toString('base64url');
  await q(`INSERT INTO sistema (id, dados) VALUES ('segredo-sessao', $1) ON CONFLICT (id) DO NOTHING`, [{ valor: novo }]);
  const r = await q(`SELECT dados FROM sistema WHERE id = 'segredo-sessao'`);
  return r.rows[0].dados.valor;
}

// Remove evidências enviadas mas nunca vinculadas a uma ação (mais de 1 dia)
async function limparEvidencias() {
  const r = await q("DELETE FROM evidencias WHERE acao_id IS NULL AND enviado_em < now() - interval '1 day' RETURNING id");
  r.rows.forEach(x => fs.unlink(path.join(config.uploadDir, x.id), () => {}));
}

// Inicialização única por instância (no servidor comum roda uma vez; no Vercel, a cada instância nova)
let inicializacao = null;
function iniciar() {
  if (!inicializacao) {
    inicializacao = (async () => {
      await migrar();
      middlewareSessao = session(opcoesSessao(await segredoSessao()));
      await contas.garantirPrimeiroAdmin();
      if (config.importarPiloto) {
        const vazio = (await q('SELECT count(*)::int AS n FROM normas')).rows[0].n === 0;
        if (vazio) await importarBackup(path.join(__dirname, '..', 'dados', 'backup-claude-2026-11-03.json')).catch(err => console.error('[importação]', err.message));
      }
      limparEvidencias().catch(() => {});
    })();
    inicializacao.catch(() => { inicializacao = null; }); // falhou: tenta de novo na próxima requisição
  }
  return inicializacao;
}

// Servidor comum (Docker, Railway, TI da empresa). No Vercel, quem chama o app é api/index.js.
if (require.main === module) {
  iniciar().then(() => {
    cron.schedule('15 3 * * *', () => limparEvidencias().catch(() => {}), { timezone: config.captura.fusoHorario });
    if (config.captura.ativa) {
      cron.schedule(config.captura.cron, () => {
        rodarCaptura('agendada').catch(err => console.error('[captura]', err));
      }, { timezone: config.captura.fusoHorario });
      console.log(`[captura] agendada: "${config.captura.cron}" (${config.captura.fusoHorario})`);
    }
    if (config.authMode === 'dev') console.warn('[auth] MODO DE TESTE (AUTH_MODE=dev): qualquer pessoa entra sem senha. Não use em produção.');
    app.listen(config.porta, () => console.log(`Controle Normativo em ${config.baseUrl} (porta ${config.porta})`));
  }).catch(err => { console.error(err); process.exit(1); });
}

module.exports = app;
