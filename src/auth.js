'use strict';
// Login: Microsoft Entra ID (OpenID Connect, fluxo de código com PKCE) ou modo "dev" para testes locais.
const crypto = require('crypto');
const express = require('express');
const { config } = require('./config');
const { q } = require('./db');

const PERFIS = ['Admin', 'Analista', 'Leitura'];
const router = express.Router();

let cca = null;
let cryptoProvider = null;
function cliente() {
  if (!cca) {
    const msal = require('@azure/msal-node');
    cca = new msal.ConfidentialClientApplication({
      auth: {
        clientId: config.entra.clientId,
        authority: `https://login.microsoftonline.com/${config.entra.tenantId}`,
        clientSecret: config.entra.clientSecret,
      },
    });
    cryptoProvider = new msal.CryptoProvider();
  }
  return cca;
}

const redirectUri = () => `${config.baseUrl}/auth/callback`;
const ESCOPOS = ['openid', 'profile', 'email'];

// Perfil a partir das App Roles (preferencial) ou dos grupos do Entra ID
function perfilDasClaims(claims) {
  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  for (const p of PERFIS) if (roles.includes(p)) return p;
  const grupos = Array.isArray(claims.groups) ? claims.groups : [];
  const g = config.entra;
  if (g.grupoAdmin && grupos.includes(g.grupoAdmin)) return 'Admin';
  if (g.grupoAnalista && grupos.includes(g.grupoAnalista)) return 'Analista';
  if (g.grupoLeitura && grupos.includes(g.grupoLeitura)) return 'Leitura';
  return config.entra.exigirPerfil ? null : 'Leitura';
}

async function registrarUsuario(u) {
  await q(`INSERT INTO usuarios (id, nome, email, perfil, ultimo_acesso) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, email = EXCLUDED.email, perfil = EXCLUDED.perfil, ultimo_acesso = now()`,
    [u.id, u.nome, u.email, u.perfil]);
}

function entrar(req, res, usuario, destino = '/') {
  req.session.regenerate(err => {
    if (err) return res.status(500).send('Não foi possível iniciar a sessão.');
    req.session.usuario = usuario;
    req.session.save(() => res.redirect(destino));
  });
}

router.get('/auth/login', async (req, res, next) => {
  try {
    if (config.authMode === 'local') return res.redirect('/login');
    if (config.authMode === 'dev') {
      const perfil = PERFIS.includes(req.query.perfil) ? req.query.perfil : config.dev.perfil;
      const usuario = { id: 'dev-' + perfil.toLowerCase(), nome: `${config.dev.nome} (${perfil})`, email: null, perfil };
      await registrarUsuario(usuario);
      return entrar(req, res, usuario);
    }
    const app = cliente();
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oidc = { state, verifier };
    const url = await app.getAuthCodeUrl({
      scopes: ESCOPOS, redirectUri: redirectUri(), state,
      codeChallenge: challenge, codeChallengeMethod: 'S256', responseMode: 'query', prompt: 'select_account',
    });
    req.session.save(() => res.redirect(url));
  } catch (err) { next(err); }
});

router.get('/auth/callback', async (req, res, next) => {
  try {
    if (config.authMode !== 'entra') return res.redirect('/');
    const oidc = req.session.oidc;
    if (req.query.error) return res.status(401).send(paginaAviso('Login não concluído', String(req.query.error_description || req.query.error)));
    if (!oidc || !req.query.state || req.query.state !== oidc.state) return res.status(400).send(paginaAviso('Login expirado', 'Volte e tente entrar de novo.'));
    const r = await cliente().acquireTokenByCode({
      code: String(req.query.code || ''), scopes: ESCOPOS, redirectUri: redirectUri(), codeVerifier: oidc.verifier,
    });
    const c = r.idTokenClaims || {};
    if (c._claim_names && c._claim_names.groups && !(c.roles || []).length) {
      console.warn('[auth] Usuário com excesso de grupos (overage). Use App Roles ou "grupos atribuídos ao aplicativo".');
    }
    const perfil = perfilDasClaims(c);
    if (!perfil) {
      return res.status(403).send(paginaAviso('Acesso não liberado',
        'Seu usuário ainda não tem perfil no Controle Normativo. Peça ao administrador para incluir você como Admin, Analista ou Leitura.'));
    }
    const usuario = { id: c.oid || c.sub, nome: c.name || c.preferred_username || 'Usuário', email: c.preferred_username || c.email || null, perfil };
    await registrarUsuario(usuario);
    entrar(req, res, usuario);
  } catch (err) { next(err); }
});

router.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('cn.sid');
    if (config.authMode === 'entra') {
      return res.redirect(`https://login.microsoftonline.com/${config.entra.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.baseUrl + '/saiu')}`);
    }
    res.redirect(config.authMode === 'local' ? '/login?saiu=1' : '/saiu');
  });
});

router.get('/saiu', (req, res) => res.send(paginaAviso('Você saiu do Controle Normativo', '<a href="/auth/login">Entrar novamente</a>', true)));

function exigirLogin(req, res, next) {
  if (req.session && req.session.usuario) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/_blob/')) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
  return res.redirect(config.authMode === 'local' ? '/login' : '/auth/login');
}

const exigirPerfil = (...perfis) => (req, res, next) => {
  const u = req.session && req.session.usuario;
  if (u && perfis.includes(u.perfil)) return next();
  res.status(403).json({ erro: perfis.includes('Analista') ? 'Seu perfil é somente leitura.' : 'Somente o perfil Admin pode fazer isso.' });
};

function paginaAviso(titulo, msg, html = false) {
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · Controle Normativo</title>
<body style="font:16px/1.5 system-ui,sans-serif;background:#F2F4F3;color:#14201C;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<div style="max-width:440px;background:#fff;border:1px solid #D3DBD8;border-radius:10px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">${esc(titulo)}</h1><p style="margin:0">${html ? msg : esc(msg)}</p></div></body></html>`;
}

module.exports = { router, exigirLogin, exigirPerfil, perfilDasClaims, PERFIS };
