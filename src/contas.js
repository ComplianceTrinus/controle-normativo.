'use strict';
// Login próprio (AUTH_MODE=local): e-mail e senha, troca de senha e cadastro de usuários pelo Admin.
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { config } = require('./config');
const { q } = require('./db');
const { registrarAuditoria } = require('./colecoes');

const scrypt = promisify(crypto.scrypt);
const PERFIS = ['Admin', 'Analista', 'Leitura'];
const SENHA_MIN = 10;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MIN = 15;

// ---- senhas (scrypt, sal aleatório) ----
async function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
}
async function conferir(senha, armazenado) {
  try {
    const [alg, N, r, p, sal, h] = String(armazenado).split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(h, 'base64');
    const calc = await scrypt(senha, Buffer.from(sal, 'base64'), esperado.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(calc, esperado);
  } catch { return false; }
}
function senhaTemporaria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), b => alfabeto[b % alfabeto.length]).join('');
}
function validarSenha(s) {
  if (typeof s !== 'string' || s.length < SENHA_MIN) return `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`;
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
  return '';
}
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---- primeiro administrador, a partir das variáveis ADMIN_EMAIL e ADMIN_SENHA_INICIAL ----
async function garantirPrimeiroAdmin() {
  if (config.authMode !== 'local') return;
  const existe = await q("SELECT 1 FROM usuarios WHERE senha_hash IS NOT NULL AND perfil = 'Admin' AND ativo LIMIT 1");
  if (existe.rowCount) return;
  const { adminEmail, adminSenhaInicial, adminNome } = config.local;
  if (!adminEmail || !adminSenhaInicial) {
    console.warn('[login] Nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA_INICIAL e reinicie.');
    return;
  }
  const id = 'loc-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await q(`INSERT INTO usuarios (id, nome, email, perfil, senha_hash, ativo, trocar_senha)
           VALUES ($1, $2, $3, 'Admin', $4, true, true)`, [id, adminNome, adminEmail, await gerarHash(adminSenhaInicial)]);
  await registrarAuditoria({ acao: 'Criou', tipo: 'Usuário', ref: adminEmail, detalhe: 'Primeiro administrador (variáveis de ambiente)' }, null);
  console.log(`[login] Administrador ${adminEmail} criado. Troca de senha exigida no primeiro acesso.`);
}

// ---- proteção simples por IP contra tentativas em massa ----
const porIp = new Map();
function limiteIp(ip) {
  const agora = Date.now();
  const r = porIp.get(ip) || { n: 0, desde: agora };
  if (agora - r.desde > 15 * 60e3) { r.n = 0; r.desde = agora; }
  r.n++; porIp.set(ip, r);
  return r.n <= 30;
}

// ---- token anti-CSRF dos formulários ----
function tokenCsrf(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function conferirCsrf(req) {
  const t = String(req.body && req.body._csrf || '');
  return !!req.session.csrf && t.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.session.csrf));
}

// ---- páginas (HTML simples, mesmo visual do sistema) ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pagina(titulo, corpo, { largo = false } = {}) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · Controle Normativo</title>
<style>
:root{--bg:#F2F4F3;--sf:#fff;--ink:#14201C;--mu:#5A6762;--ln:#D3DBD8;--ac:#0B5D57;--aci:#fff;--cr:#B3261E;--crs:#F8E0DE;--ok:#1D7646;--oks:#DDF0E4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0F1513;--sf:#161E1B;--ink:#E3EBE8;--mu:#97A6A0;--ln:#2B3833;--ac:#55B5A8;--aci:#06201C;--cr:#F08077;--crs:#3D1C1A;--ok:#5CC48A;--oks:#173326;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Source Sans 3",system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 16px;min-height:100vh}
.box{max-width:${largo ? 980 : 420}px;margin:0 auto;background:var(--sf);border:1px solid var(--ln);border-radius:10px;padding:24px}
.marca{display:flex;gap:10px;align-items:center;margin-bottom:18px}.marca span{width:32px;height:32px;border-radius:7px;background:var(--ac);color:var(--aci);display:grid;place-items:center;font-weight:700;font-size:19px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 14px}.mu{color:var(--mu);font-size:13.5px}
form{display:flex;flex-direction:column;gap:12px}label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:600;color:var(--mu)}
input,select{font:inherit;color:var(--ink);background:var(--sf);border:1px solid var(--ln);border-radius:6px;padding:8px 10px;min-height:38px}
button,.bt{font:inherit;font-weight:600;border:1px solid var(--ac);background:var(--ac);color:var(--aci);border-radius:6px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
.sec{background:var(--sf);color:var(--ink);border-color:var(--ln)}.peq{padding:4px 9px;font-size:13px;font-weight:500}
.msg{padding:10px 12px;border-radius:6px;font-size:14px;margin-bottom:12px}.err{background:var(--crs);color:var(--cr)}.ok{background:var(--oks);color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu);padding:8px;border-bottom:1px solid var(--ln)}
td{padding:8px;border-top:1px solid var(--ln);vertical-align:middle}.tw{overflow-x:auto}.linha{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end}
code{font-size:15px;background:var(--bg);border:1px solid var(--ln);padding:4px 8px;border-radius:5px;user-select:all}
a{color:var(--ac)}
</style></head><body><div class="box"><div class="marca"><span>§</span><b>Controle Normativo</b></div>${corpo}</div></body></html>`;
}
const aviso = m => m ? `<div class="msg ${m.tipo}">${m.html ? m.texto : esc(m.texto)}</div>` : '';

const router = express.Router();
router.use(['/login', '/auth/local', '/conta/senha', '/usuarios'], express.urlencoded({ extended: false, limit: '20kb' }));

function telaLogin(req, res, msg, email = '') {
  res.status(msg && msg.tipo === 'err' ? 401 : 200).send(pagina('Entrar', `<h1>Entrar</h1><p class="mu">Use o e-mail e a senha cadastrados pelo administrador.</p>${aviso(msg)}
<form method="post" action="/auth/local"><input type="hidden" name="_csrf" value="${tokenCsrf(req)}">
<label>E-mail<input type="email" name="email" id="email" autocomplete="username" required value="${esc(email)}" autofocus></label>
<label>Senha<input type="password" name="senha" id="senha" autocomplete="current-password" required></label>
<button type="submit">Entrar</button></form>`));
}

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  req.session.save(() => telaLogin(req, res, req.query.saiu ? { tipo: 'ok', texto: 'Você saiu do sistema.' } : null));
});

router.post('/auth/local', async (req, res, next) => {
  try {
    if (!conferirCsrf(req)) return telaLogin(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!limiteIp(req.ip)) return telaLogin(req, res, { tipo: 'err', texto: 'Muitas tentativas. Aguarde 15 minutos.' }, email);
    const r = await q('SELECT * FROM usuarios WHERE lower(email) = $1 AND senha_hash IS NOT NULL', [email]);
    const u = r.rows[0];
    const falha = () => telaLogin(req, res, { tipo: 'err', texto: 'E-mail ou senha incorretos.' }, email);
    if (!u) { await gerarHash(senha); return falha(); } // tempo semelhante, não revela se o e-mail existe
    if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) {
      return telaLogin(req, res, { tipo: 'err', texto: `Acesso bloqueado temporariamente por tentativas erradas. Tente após ${new Date(u.bloqueado_ate).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}.` }, email);
    }
    if (!(await conferir(senha, u.senha_hash))) {
      const n = u.tentativas + 1;
      await q('UPDATE usuarios SET tentativas = $2, bloqueado_ate = $3 WHERE id = $1',
        [u.id, n >= MAX_TENTATIVAS ? 0 : n, n >= MAX_TENTATIVAS ? new Date(Date.now() + BLOQUEIO_MIN * 60e3) : null]);
      if (n >= MAX_TENTATIVAS) await registrarAuditoria({ acao: 'Bloqueou', tipo: 'Usuário', ref: u.email, detalhe: `${MAX_TENTATIVAS} tentativas de senha erradas` }, null);
      return falha();
    }
    if (!u.ativo) return telaLogin(req, res, { tipo: 'err', texto: 'Usuário desativado. Fale com o administrador.' }, email);
    await q('UPDATE usuarios SET tentativas = 0, bloqueado_ate = NULL, ultimo_acesso = now() WHERE id = $1', [u.id]);
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.usuario = { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, trocarSenha: u.trocar_senha };
      req.session.save(() => res.redirect(u.trocar_senha ? '/conta/senha' : '/'));
    });
  } catch (err) { next(err); }
});

// Exige login para as páginas abaixo
function logado(req, res, next) { if (req.session.usuario) return next(); res.redirect('/login'); }

function telaSenha(req, res, msg) {
  const obrig = req.session.usuario.trocarSenha;
  res.send(pagina('Trocar senha', `<h1>${obrig ? 'Crie sua senha' : 'Trocar senha'}</h1>
<p class="mu">${obrig ? 'Por segurança, troque a senha provisória antes de continuar.' : 'Mínimo de 10 caracteres, com letras e números.'}</p>${aviso(msg)}
<form method="post" action="/conta/senha"><input type="hidden" name="_csrf" value="${tokenCsrf(req)}">
<label>Senha atual${obrig ? ' (provisória)' : ''}<input type="password" name="atual" id="atual" autocomplete="current-password" required></label>
<label>Nova senha<input type="password" name="nova" id="nova" autocomplete="new-password" required minlength="${SENHA_MIN}"></label>
<label>Repita a nova senha<input type="password" name="nova2" id="nova2" autocomplete="new-password" required minlength="${SENHA_MIN}"></label>
<div class="linha"><button type="submit">Salvar senha</button>${obrig ? '' : '<a class="bt sec" href="/">Voltar</a>'}</div></form>`));
}
router.get('/conta/senha', logado, (req, res) => {
  if (config.authMode !== 'local') return res.redirect('/');
  req.session.save(() => telaSenha(req, res));
});
router.post('/conta/senha', logado, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaSenha(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const { atual = '', nova = '', nova2 = '' } = req.body;
    const r = await q('SELECT senha_hash FROM usuarios WHERE id = $1', [req.session.usuario.id]);
    if (!r.rows[0] || !(await conferir(atual, r.rows[0].senha_hash))) return telaSenha(req, res, { tipo: 'err', texto: 'A senha atual não confere.' });
    const prob = validarSenha(nova) || (nova !== nova2 ? 'As duas senhas novas não são iguais.' : '') || (nova === atual ? 'A nova senha precisa ser diferente da atual.' : '');
    if (prob) return telaSenha(req, res, { tipo: 'err', texto: prob });
    await q('UPDATE usuarios SET senha_hash = $2, trocar_senha = false WHERE id = $1', [req.session.usuario.id, await gerarHash(nova)]);
    await registrarAuditoria({ acao: 'Trocou a senha', tipo: 'Usuário', ref: req.session.usuario.email, detalhe: '' }, req.session.usuario.id);
    const u = { ...req.session.usuario, trocarSenha: false };
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.usuario = u;
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) { next(err); }
});

// Enquanto a senha provisória não for trocada, só a página de troca fica acessível
function exigirSenhaDefinitiva(req, res, next) {
  const u = req.session.usuario;
  if (!u || !u.trocarSenha || req.path === '/conta/senha' || req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ erro: 'Troque a senha provisória antes de continuar.' });
  res.redirect('/conta/senha');
}

// ---- cadastro de usuários (somente Admin) ----
function soAdmin(req, res, next) {
  if (req.session.usuario && req.session.usuario.perfil === 'Admin') return next();
  res.status(403).send(pagina('Sem permissão', '<h1>Sem permissão</h1><p>Somente o perfil Admin gerencia usuários.</p><a class="bt sec" href="/">Voltar</a>'));
}

async function telaUsuarios(req, res, msg) {
  const lista = (await q('SELECT id, nome, email, perfil, ativo, trocar_senha, ultimo_acesso, bloqueado_ate FROM usuarios WHERE senha_hash IS NOT NULL ORDER BY ativo DESC, nome')).rows;
  const csrf = tokenCsrf(req);
  const opt = (sel) => PERFIS.map(p => `<option${p === sel ? ' selected' : ''}>${p}</option>`).join('');
  const linhas = lista.map(u => {
    const eu = u.id === req.session.usuario.id;
    const sit = !u.ativo ? 'Desativado' : u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date() ? 'Bloqueado (tentativas)' : u.trocar_senha ? 'Aguardando primeira senha' : 'Ativo';
    return `<tr><td><b>${esc(u.nome)}</b><div class="mu">${esc(u.email)}</div></td>
<td><form method="post" action="/usuarios/${esc(u.id)}" class="linha"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="perfil">
<select name="perfil" aria-label="Perfil de ${esc(u.nome)}"${eu ? ' disabled' : ''}>${opt(u.perfil)}</select>${eu ? '' : '<button class="sec peq">Salvar</button>'}</form></td>
<td>${esc(sit)}<div class="mu">${u.ultimo_acesso ? 'Último acesso ' + new Date(u.ultimo_acesso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : ''}</div></td>
<td>${eu ? '<span class="mu">Você</span>' : `<div class="linha">
<form method="post" action="/usuarios/${esc(u.id)}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="senha"><button class="sec peq">Gerar nova senha</button></form>
<form method="post" action="/usuarios/${esc(u.id)}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="${u.ativo ? 'desativar' : 'ativar'}"><button class="sec peq">${u.ativo ? 'Desativar' : 'Reativar'}</button></form></div>`}</td></tr>`;
  }).join('');
  res.send(pagina('Usuários', `<div class="linha" style="justify-content:space-between;margin-bottom:8px"><h1>Usuários</h1><a class="bt sec peq" href="/">Voltar ao sistema</a></div>
<p class="mu">Admin: tudo, inclusive exclusões e usuários. Analista: cadastra e edita. Leitura: só consulta.</p>${aviso(msg)}
<h2 style="font-size:16px;margin:18px 0 8px">Novo usuário</h2>
<form method="post" action="/usuarios"><input type="hidden" name="_csrf" value="${csrf}"><div class="grid">
<label>Nome<input name="nome" id="novoNome" required maxlength="120"></label>
<label>E-mail<input type="email" name="email" id="novoEmail" required maxlength="200"></label>
<label>Perfil<select name="perfil" id="novoPerfil">${opt('Analista')}</select></label>
<button type="submit">Cadastrar</button></div></form>
<p class="mu" style="margin-top:8px">O sistema gera uma senha provisória para você repassar à pessoa. Ela troca a senha no primeiro acesso.</p>
<h2 style="font-size:16px;margin:22px 0 8px">Equipe</h2>
<div class="tw"><table><thead><tr><th>Pessoa</th><th>Perfil</th><th>Situação</th><th>Ações</th></tr></thead><tbody>${linhas}</tbody></table></div>`, { largo: true }));
}

const msgSenha = (u, senha, prefixo) => ({
  tipo: 'ok', html: true,
  texto: `${esc(prefixo)} Senha provisória de <b>${esc(u)}</b>: <code>${esc(senha)}</code><br><span style="font-size:13px">Anote agora e repasse por um canal seguro: ela não será mostrada de novo. A pessoa troca a senha no primeiro acesso.</span>`,
});

router.get('/usuarios', logado, soAdmin, (req, res, next) => {
  if (config.authMode !== 'local') return res.status(404).send(pagina('Indisponível', '<h1>Usuários</h1><p>Com login corporativo, os usuários e perfis são gerenciados no Microsoft Entra ID.</p><a class="bt sec" href="/">Voltar</a>'));
  telaUsuarios(req, res).catch(next);
});

router.post('/usuarios', logado, soAdmin, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaUsuarios(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const nome = String(req.body.nome || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase();
    const perfil = PERFIS.includes(req.body.perfil) ? req.body.perfil : 'Leitura';
    if (!nome || !emailValido(email)) return telaUsuarios(req, res, { tipo: 'err', texto: 'Informe nome e um e-mail válido.' });
    const ja = await q('SELECT 1 FROM usuarios WHERE lower(email) = $1 AND senha_hash IS NOT NULL', [email]);
    if (ja.rowCount) return telaUsuarios(req, res, { tipo: 'err', texto: 'Já existe um usuário com esse e-mail.' });
    const senha = senhaTemporaria();
    const id = 'loc-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await q(`INSERT INTO usuarios (id, nome, email, perfil, senha_hash, ativo, trocar_senha) VALUES ($1,$2,$3,$4,$5,true,true)`,
      [id, nome, email, perfil, await gerarHash(senha)]);
    await registrarAuditoria({ acao: 'Criou', tipo: 'Usuário', ref: email, detalhe: `Perfil ${perfil}` }, req.session.usuario.id);
    telaUsuarios(req, res, msgSenha(email, senha, 'Usuário cadastrado.'));
  } catch (err) { next(err); }
});

router.post('/usuarios/:id', logado, soAdmin, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaUsuarios(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const id = req.params.id;
    if (id === req.session.usuario.id) return telaUsuarios(req, res, { tipo: 'err', texto: 'Você não pode alterar o próprio perfil ou desativar a si mesmo.' });
    const r = await q('SELECT * FROM usuarios WHERE id = $1 AND senha_hash IS NOT NULL', [id]);
    const u = r.rows[0];
    if (!u) return telaUsuarios(req, res, { tipo: 'err', texto: 'Usuário não encontrado.' });
    const quem = req.session.usuario.id;
    switch (req.body.acao) {
      case 'perfil': {
        const perfil = PERFIS.includes(req.body.perfil) ? req.body.perfil : u.perfil;
        if (perfil === u.perfil) return telaUsuarios(req, res);
        await q('UPDATE usuarios SET perfil = $2 WHERE id = $1', [id, perfil]);
        await q("DELETE FROM sessoes WHERE sess -> 'usuario' ->> 'id' = $1", [id]).catch(() => {});
        await registrarAuditoria({ acao: 'Alterou', tipo: 'Usuário', ref: u.email, detalhe: `Perfil: ${u.perfil} → ${perfil}` }, quem);
        return telaUsuarios(req, res, { tipo: 'ok', texto: `Perfil de ${u.email} alterado para ${perfil}.` });
      }
      case 'senha': {
        const senha = senhaTemporaria();
        await q('UPDATE usuarios SET senha_hash = $2, trocar_senha = true, tentativas = 0, bloqueado_ate = NULL WHERE id = $1', [id, await gerarHash(senha)]);
        await q("DELETE FROM sessoes WHERE sess -> 'usuario' ->> 'id' = $1", [id]).catch(() => {});
        await registrarAuditoria({ acao: 'Redefiniu a senha', tipo: 'Usuário', ref: u.email, detalhe: '' }, quem);
        return telaUsuarios(req, res, msgSenha(u.email, senha, 'Nova senha gerada.'));
      }
      case 'desativar':
      case 'ativar': {
        const ativo = req.body.acao === 'ativar';
        await q('UPDATE usuarios SET ativo = $2 WHERE id = $1', [id, ativo]);
        if (!ativo) await q("DELETE FROM sessoes WHERE sess -> 'usuario' ->> 'id' = $1", [id]).catch(() => {});
        await registrarAuditoria({ acao: ativo ? 'Reativou' : 'Desativou', tipo: 'Usuário', ref: u.email, detalhe: '' }, quem);
        return telaUsuarios(req, res, { tipo: 'ok', texto: `${u.email} ${ativo ? 'reativado' : 'desativado'}.` });
      }
      default:
        return telaUsuarios(req, res);
    }
  } catch (err) { next(err); }
});

// Revalida a cada requisição se o usuário continua ativo e com o mesmo perfil
async function revalidar(req, res, next) {
  const u = req.session && req.session.usuario;
  if (!u || config.authMode !== 'local') return next();
  try {
    const r = await q('SELECT perfil, ativo, nome FROM usuarios WHERE id = $1', [u.id]);
    const atual = r.rows[0];
    if (!atual || !atual.ativo) return req.session.destroy(() => (req.path.startsWith('/api/') ? res.status(401).json({ erro: 'Sessão encerrada.' }) : res.redirect('/login')));
    u.perfil = atual.perfil; u.nome = atual.nome;
    next();
  } catch (err) { next(err); }
}

module.exports = { router, garantirPrimeiroAdmin, exigirSenhaDefinitiva, revalidar, gerarHash, conferir, validarSenha };
