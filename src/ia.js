'use strict';
// Sugestão de análise pela IA (Claude, da Anthropic), lendo o texto completo da norma quando disponível
// (Busca de normas do BCB ou página da CVM). A sugestão nunca é salva sozinha: quem analisa revisa,
// aplica na ficha e salva. Cada pedido fica na trilha de auditoria.
// Configuração na Vercel: ANTHROPIC_API_KEY (obrigatória); IA_MODELO e IA_PERFIL_INSTITUICAO (opcionais).
const express = require('express');
const { q } = require('./db');
const { registrarAuditoria, listarAreas } = require('./colecoes');
const { buscar } = require('./captura/util');

const router = express.Router();
const chaveApi = () => (process.env.ANTHROPIC_API_KEY || '').trim();
const modelo = () => (process.env.IA_MODELO || 'claude-sonnet-5-5').trim();
const podeUsar = req => ['Admin', 'Analista'].includes(req.session.usuario && req.session.usuario.perfil);
const cite = n => `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;

const limpa = h => String(h || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
  .replace(/[\u200b\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Texto integral: BCB/CMN pela API da Busca de normas; CVM pela página oficial. Outros: só a ementa.
async function textoCompleto(n) {
  const link = String(n.link || '');
  try {
    const m = link.match(/exibenormativo\?tipo=([^&]+)&numero=(\d+)/);
    if (m) {
      const j = await buscar(`https://www.bcb.gov.br/api/conteudo/app/normativos/exibenormativo?p1=${m[1]}&p2=${m[2]}`, { tipo: 'json', tentativas: 2, timeoutMs: 20000 });
      const it = j && Array.isArray(j.conteudo) ? j.conteudo[0] : null;
      return it ? limpa(it.Texto).slice(0, 60000) : '';
    }
    if (/^https:\/\/conteudo\.cvm\.gov\.br\//.test(link)) {
      const t = limpa(await buscar(link, { tentativas: 2, timeoutMs: 20000 }));
      return t.length > 400 ? t.slice(0, 60000) : '';
    }
  } catch (e) { console.error('[ia texto]', e.message); }
  return '';
}

const SISTEMA = `Você é um analista sênior de Compliance regulatório no Brasil (Banco Central, CMN, CVM e ANBIMA).
Avalie normas para a instituição indicada, com base apenas no texto fornecido. Seja objetivo e conservador:
na dúvida sobre aplicabilidade, explique a dúvida. Cite os artigos que sustentam a conclusão.
Responda SOMENTE com um objeto JSON válido, sem nenhum texto antes ou depois.`;

function pedido(n, areas, texto) {
  const inst = (process.env.IA_PERFIL_INSTITUICAO || 'Grupo Trinus, com instituições reguladas pelo Banco Central do Brasil e pela CVM').trim();
  return `Instituição: ${inst}
Áreas da instituição (use só estes nomes): ${areas.join(', ')}

Norma: ${cite(n)}${n.data ? ` (publicada em ${n.data})` : ''}
Ementa: ${n.ementa}
${texto ? `\nTexto integral da norma:\n"""\n${texto}\n"""\n` : '\n(Texto integral indisponível: avalie pela ementa e deixe isso claro na justificativa.)\n'}
Formato da resposta:
{"aplicavel":"Sim ou Não","justificativa":"até 4 linhas","areas":["..."],"risco":"Alta, Média ou Baixa","riscoMotivo":"1 linha","envioRegulador":"Sim ou Não","atualizaPolitica":"Sim ou Não","politicas":["tipos de política interna provavelmente afetados, ex.: Política de PLD/FTP"],"oQueMuda":"até 3 linhas","fontes":["artigos da norma que sustentam a análise"]}`;
}

function extrairJson(txt) {
  const t = String(txt || '');
  const bloco = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = bloco ? bloco[1] : (t.match(/\{[\s\S]*\}/) || [''])[0];
  try { return JSON.parse(cand); } catch { return null; }
}
const nz = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const um = (v, ok, pad = '') => (ok.find(x => nz(v).startsWith(nz(x).slice(0, 3))) || pad);

router.get('/api/ia/status', (req, res) => res.json({ configurado: !!chaveApi(), podeUsar: podeUsar(req), modelo: chaveApi() ? modelo() : '' }));

router.post('/api/ia/sugerir', async (req, res) => {
  try {
    if (!chaveApi()) return res.status(400).json({ erro: 'A IA ainda não foi configurada (falta a chave ANTHROPIC_API_KEY na Vercel).' });
    if (!podeUsar(req)) return res.status(403).json({ erro: 'Somente o Compliance usa a sugestão da IA.' });
    const id = String((req.body && req.body.normaId) || '');
    const n = (await q("SELECT id, orgao, tipo, numero, ementa, link, to_char(data_publicacao, 'DD/MM/YYYY') AS data FROM normas WHERE id = $1 AND excluido_em IS NULL", [id])).rows[0];
    if (!n) return res.status(404).json({ erro: 'Norma não encontrada.' });
    const areas = await listarAreas();
    const texto = await textoCompleto(n);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chaveApi(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo(), max_tokens: 1500, system: SISTEMA, messages: [{ role: 'user', content: pedido(n, areas, texto) }] }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
      return res.status(502).json({ erro: (r.status === 401 ? 'A chave da IA foi recusada (confira a ANTHROPIC_API_KEY na Vercel): ' : 'A IA não respondeu: ') + msg });
    }
    const resposta = (Array.isArray(j.content) ? j.content : []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    const s = extrairJson(resposta) || {};
    const sug = {
      aplicavel: um(s.aplicavel, ['Sim', 'Não']),
      justificativa: String(s.justificativa || '').slice(0, 2000),
      areas: (Array.isArray(s.areas) ? s.areas : []).map(a => areas.find(x => nz(x) === nz(a))).filter(Boolean),
      risco: um(s.risco, ['Alta', 'Média', 'Baixa']),
      riscoMotivo: String(s.riscoMotivo || '').slice(0, 500),
      envioRegulador: um(s.envioRegulador, ['Sim', 'Não']),
      atualizaPolitica: um(s.atualizaPolitica, ['Sim', 'Não']),
      politicas: (Array.isArray(s.politicas) ? s.politicas : []).map(String).slice(0, 10),
      oQueMuda: String(s.oQueMuda || '').slice(0, 1500),
      fontes: (Array.isArray(s.fontes) ? s.fontes : []).map(String).slice(0, 10),
    };
    await registrarAuditoria({ acao: 'Pediu sugestão', tipo: 'Norma', ref: cite(n),
      detalhe: `IA (${modelo()})${texto ? ', com o texto integral' : ', só pela ementa'} · aplicável: ${sug.aplicavel || '—'} · risco: ${sug.risco || '—'} · áreas: ${sug.areas.join(', ') || '—'}` }, req.session.usuario.id);
    res.json({ fonte: 'ia', modelo: modelo(), comTexto: !!texto, sugestao: sug, texto: Object.keys(s).length ? '' : resposta.slice(0, 4000), fontes: sug.fontes, em: new Date().toISOString() });
  } catch (e) {
    console.error('[ia]', e.message);
    res.status(500).json({ erro: 'Não foi possível consultar a IA: ' + e.message });
  }
});

module.exports = { router };
