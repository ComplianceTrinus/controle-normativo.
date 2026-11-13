'use strict';
// Resumo diário de normas novas por e-mail, enviado pelo Resend (API HTTP, sem dependência extra).
// Só envia quando há norma cadastrada desde o último envio. Destinatários: tela "Envio por e-mail" (só Admin).
const { q } = require('./db');
const { config } = require('./config');
const { lerSistema, gravarSistema, registrarAuditoria } = require('./colecoes');

class ErroEmail extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const cfg = () => ({
  chave: process.env.RESEND_API_KEY || '',
  remetente: process.env.EMAIL_REMETENTE || 'Controle Normativo <onboarding@resend.dev>',
});

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isoDia = d => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
const br = d => { const s = isoDia(d); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : ''; };
const cite = n => `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;
const ORDEM = ['BACEN', 'CMN', 'CVM', 'ANBIMA'];

async function destinatarios() {
  const d = await lerSistema('destinatarios');
  const lista = d && Array.isArray(d.lista) ? d.lista
    : (config.local.adminEmail ? [{ email: config.local.adminEmail, ativo: true }] : []);
  return lista.filter(x => x && x.ativo !== false && x.email).map(x => x.email);
}

async function statusEnvio() {
  const e = (await lerSistema('email')) || {};
  const c = cfg();
  return { configurado: !!c.chave, remetente: c.remetente, ultimoEnvio: e.ultimoEnvio || null, ultimaVerificacao: e.ultimaVerificacao || null, ultimoResultado: e.ultimoResultado || '' };
}

function montar(normas, { teste = false } = {}) {
  const grupos = {};
  for (const n of normas) (grupos[n.orgao] = grupos[n.orgao] || []).push(n);
  const orgaos = Object.keys(grupos).sort((a, b) => (ORDEM.indexOf(a) + 1 || 99) - (ORDEM.indexOf(b) + 1 || 99));
  const qtd = normas.length;
  const titulo = `${qtd} ${qtd === 1 ? 'norma nova' : 'normas novas'} para triagem`;
  const linkSistema = config.baseUrl + '/#normas';
  let html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F5F5F5;font-family:'Plus Jakarta Sans',Segoe UI,Arial,sans-serif;color:#191A1C">
<div style="max-width:680px;margin:0 auto;padding:24px 16px">
<div style="background:linear-gradient(160deg,#1E3A8A,#000D5C);color:#fff;border-radius:12px 12px 0 0;padding:20px 24px">
<div style="font-size:13px;opacity:.8">Trinus · Controle Normativo${teste ? ' · TESTE' : ''}</div>
<div style="font-size:22px;font-weight:700;margin-top:4px">${esc(titulo)}</div></div>
<div style="background:#fff;border-radius:0 0 12px 12px;padding:8px 24px 24px">`;
  let texto = `${titulo}${teste ? ' (teste)' : ''}\n\n`;
  for (const o of orgaos) {
    html += `<h2 style="font-size:15px;color:#1E3A8A;margin:20px 0 8px;border-bottom:2px solid #67E8F9;padding-bottom:4px">${esc(o)} (${grupos[o].length})</h2>`;
    texto += `== ${o} ==\n`;
    for (const n of grupos[o]) {
      const data = br(n.data_publicacao);
      html += `<div style="padding:10px 0;border-bottom:1px solid #ECEEF2">
<div style="font-weight:700">${esc(cite(n))}${data ? ` <span style="font-weight:400;color:#5B6272">· ${esc(data)}</span>` : ''}</div>
<div style="margin:4px 0 6px;font-size:14px;line-height:1.45">${esc(n.ementa)}</div>
${n.link ? `<a href="${esc(n.link)}" style="color:#1D4ED8;font-size:13px;font-weight:600">Abrir a norma no site oficial (texto e PDF)</a>` : ''}</div>`;
      texto += `- ${cite(n)}${data ? ' (' + data + ')' : ''}: ${n.ementa}\n  ${n.link || ''}\n`;
    }
    texto += '\n';
  }
  html += `<p style="margin:24px 0 0"><a href="${esc(linkSistema)}" style="background:#1D4ED8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;display:inline-block">Fazer a triagem no sistema</a></p>
<p style="font-size:12px;color:#5B6272;margin-top:20px">Enviado automaticamente pelo Controle Normativo. Para mudar quem recebe, o Admin usa a página "Envio por e-mail".</p>
</div></div></body></html>`;
  texto += `Triagem: ${linkSistema}\n`;
  const assunto = `${teste ? '[Teste] ' : ''}Controle Normativo: ${titulo}`;
  return { assunto, html, texto };
}

async function enviarResend(para, { assunto, html, texto }) {
  const c = cfg();
  if (!c.chave) throw new ErroEmail('O serviço de e-mail ainda não foi configurado (falta a variável RESEND_API_KEY no Vercel).');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.chave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: c.remetente, to: para, subject: assunto, html, text: texto }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroEmail('O Resend recusou o envio: ' + (j.message || j.name || ('HTTP ' + r.status)), 502);
  return j.id || '';
}

// origem: texto para a auditoria; teste: manda as normas dos últimos 7 dias (ou as 10 mais recentes) sem mexer no controle de envio
async function enviarResumo({ origem = 'agendado', teste = false, usuarioId = null } = {}) {
  const para = await destinatarios();
  if (!para.length) throw new ErroEmail('Nenhum destinatário ativo na página "Envio por e-mail".');
  const estado = (await lerSistema('email')) || {};
  const agora = new Date();
  let desde = teste ? new Date(agora.getTime() - 7 * 864e5) : new Date(estado.ultimoEnvio || (agora.getTime() - 864e5));
  const campos = 'id, orgao, tipo, numero, data_publicacao, ementa, link, criado_em';
  let normas = (await q(`SELECT ${campos} FROM normas WHERE criado_em > $1 ORDER BY data_publicacao DESC NULLS LAST, criado_em DESC LIMIT 200`, [desde])).rows;
  if (teste && !normas.length) normas = (await q(`SELECT ${campos} FROM normas ORDER BY criado_em DESC LIMIT 10`)).rows;
  if (!normas.length) {
    await gravarSistema('email', { ...estado, ultimaVerificacao: agora.toISOString(), ultimoResultado: 'Sem normas novas; nada enviado.' });
    return { enviado: false, motivo: 'Nenhuma norma nova desde o último envio.', para };
  }
  const id = await enviarResend(para, montar(normas, { teste }));
  const resultado = `${normas.length} ${normas.length === 1 ? 'norma' : 'normas'} para ${para.join(', ')}`;
  if (!teste) await gravarSistema('email', { ...estado, ultimoEnvio: agora.toISOString(), ultimaVerificacao: agora.toISOString(), ultimoResultado: resultado });
  await registrarAuditoria({ acao: 'Enviou', tipo: 'E-mail', ref: (teste ? 'Teste do resumo de normas' : 'Resumo diário de normas'), detalhe: resultado + ' · Origem: ' + origem + (id ? ' · id ' + id : '') }, usuarioId);
  return { enviado: true, normas: normas.length, para };
}


// Código de acesso (2FA) enviado no login
async function enviarCodigoLogin(para, codigo, minutos) {
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F5F5F5;font-family:'Plus Jakarta Sans',Segoe UI,Arial,sans-serif;color:#191A1C">
<div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:12px;padding:24px;border-top:6px solid #1D4ED8">
<div style="font-size:13px;color:#5B6272">Trinus · Controle Normativo</div>
<p style="font-size:16px">Seu código de acesso é:</p>
<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1E3A8A">${esc(codigo)}</div>
<p style="font-size:14px;color:#5B6272">Ele vale por ${Number(minutos)} minutos. Se você não tentou entrar no sistema, ignore este e-mail e avise o administrador.</p>
</div></div></body></html>`;
  const texto = `Seu código de acesso ao Controle Normativo: ${codigo}\nVale por ${Number(minutos)} minutos. Se você não tentou entrar, ignore e avise o administrador.\n`;
  return enviarResend([para], { assunto: 'Seu código de acesso ao Controle Normativo', html, texto });
}

module.exports = { enviarResumo, statusEnvio, montar, enviarCodigoLogin, ErroEmail };
