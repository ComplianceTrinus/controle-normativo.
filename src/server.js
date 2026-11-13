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
  if (!COLS.includes(req.params.col)) return res.status(404).json({ erro: 'Coleção desconhecida.' });
  try { res.json(await dados.listar(req.params.col)); } catch (e) { tratarErro(res, e); }
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

let capturaRodando = false;
async function rodarCaptura(origem) {
  if (capturaRodando) return { ignorada: true };
  capturaRodando = true;
  try { return await executarCaptura({ origem }); } finally { capturaRodando = false; }
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
app.post('/api/evidencias', escrita, (req, res) => {
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
  const r = await q('SELECT nome, tipo, conteudo FROM evidencias WHERE id = $1', [req.params.id]);
  const ev = r.rows[0];
  const arquivo = path.join(config.uploadDir, path.basename(req.params.id));
  if (!ev || (!ev.conteudo && !fs.existsSync(arquivo))) return res.status(404).send('Evidência não encontrada.');
  res.setHeader('Content-Type', ev.tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(ev.nome)}`);
  if (ev.conteudo) return res.end(ev.conteudo);
  fs.createReadStream(arquivo).pipe(res);
});

// ---- Página ----
app.get('/', (req, res) => res.type('html').send(indexHtml));
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
