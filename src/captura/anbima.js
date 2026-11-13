'use strict';
// ANBIMA — as listas são montadas por JavaScript no site, por isso a leitura usa um navegador headless (Playwright).
const { chave, brParaIso, limpa } = require('./util');

const FONTES = [
  {
    url: 'https://www.anbima.com.br/pt_br/institucional/comunicados-oficiais/circulares/circulares.htm',
    rotulo: 'Circular', tipo: 'Circular', sigla: 'anbima-circ', origem: 'Captura automática — ANBIMA (Circulares)',
  },
  {
    url: 'https://www.anbima.com.br/pt_br/autorregular/comunicados/comunicados.htm',
    rotulo: 'Comunicado', tipo: 'Comunicado', sigla: 'anbima-com', origem: 'Captura automática — ANBIMA (Comunicados da Autorregulação)',
  },
];
const URL_AUDIENCIAS = 'https://www.anbima.com.br/pt_br/autorregular/audiencias-publicas.htm';

// "page.goto: net::ERR_X at https://..." -> "net::ERR_X"
const resumirErro = err => String(err && err.message || err).split('\n')[0].replace(/^page\.\w+:\s*/, '').replace(/\s+at https?:\/\/\S+/, '').slice(0, 120);

// links: [{t: "Circular nº 2026/000030 - 29/10/2026", h: "https://..."}]; texto: innerText do <main>
function extrairLista(links, texto, fonte) {
  const linhas = String(texto || '').split(/\n+/).map(limpa).filter(Boolean);
  const re = new RegExp(`^${fonte.rotulo} nº (\\d{4})\\/(\\d+)\\s*-\\s*(\\d{2}\\/\\d{2}\\/\\d{4})`);
  const out = [];
  const vistos = new Set();
  for (const l of links || []) {
    const m = limpa(l.t).match(re);
    if (!m) continue;
    const numero = `${m[1]}/${m[2]}`;
    if (vistos.has(numero)) continue;
    vistos.add(numero);
    const i = linhas.findIndex(x => re.test(x) && x.includes(numero));
    const titulo = i >= 0 && linhas[i + 1] && !re.test(linhas[i + 1]) ? linhas[i + 1] : '';
    out.push({
      id: `${fonte.sigla}-${m[1]}-${m[2]}`,
      orgao: 'ANBIMA',
      tipo: fonte.tipo,
      numero,
      chave: chave('ANBIMA', fonte.tipo, numero),
      dataPublicacao: brParaIso(m[3]),
      ementa: titulo || `${fonte.rotulo} ANBIMA nº ${numero}`,
      tema: 'Autorregulação',
      link: l.h,
      observacoes: '',
      origem: fonte.origem,
    });
  }
  return out;
}

// itens: [{linha: "Audiência nº 2/2026 | Código de Processos", tema: "...", edital: "https://..."}]
function extrairAudiencias(itens, anoMinimo) {
  const out = [];
  const vistos = new Set();
  for (const it of itens || []) {
    const m = limpa(it.linha).match(/^Audiência nº (\d+)\/(\d{4})\s*\|\s*(.+)$/);
    if (!m) continue;
    if (anoMinimo && Number(m[2]) < anoMinimo) continue;
    const numero = `${m[1]}/${m[2]}`;
    if (vistos.has(numero)) continue;
    vistos.add(numero);
    const codigos = limpa(m[3]);
    const tema = limpa(it.tema || '');
    out.push({
      id: `anbima-aud-${m[1]}-${m[2]}`,
      orgao: 'ANBIMA',
      tipo: 'Audiência Pública',
      numero,
      chave: chave('ANBIMA', 'Audiência Pública', numero),
      dataPublicacao: '',
      ementa: tema && !/^Audiência nº/.test(tema) ? `${codigos}: ${tema}` : codigos,
      tema: 'Autorregulação',
      link: it.edital || URL_AUDIENCIAS,
      observacoes: 'Audiência pública; prazo para manifestações no edital.',
      origem: 'Captura automática — ANBIMA (Audiências Públicas)',
    });
  }
  return out;
}

async function capturarAnbima({ desde, anoAudiencias } = {}) {
  const { chromium } = require('playwright');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy, bypass: process.env.NO_PROXY || '' } : undefined });
  const falhas = [];
  const itens = [];
  try {
    const ctx = await browser.newContext({ locale: 'pt-BR' });
    const page = await ctx.newPage();
    for (const f of FONTES) {
      try {
        await page.goto(f.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const re = `${f.rotulo} nº \\d{4}\\/\\d+`;
        await page.waitForFunction(r => [...document.querySelectorAll('main a')].some(a => new RegExp(r).test(a.textContent)), re, { timeout: 30000 });
        const links = await page.$$eval('main a', as => as.map(a => ({ t: a.textContent, h: a.href })));
        const texto = await page.$eval('main', m => m.innerText);
        const lista = extrairLista(links, texto, f).filter(x => !desde || !x.dataPublicacao || x.dataPublicacao >= desde);
        itens.push(...lista);
      } catch (err) {
        falhas.push(`${f.rotulo === 'Circular' ? 'Circulares' : 'Comunicados'}: ${resumirErro(err)}`);
      }
    }
    try {
      await page.goto(URL_AUDIENCIAS, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => /Audiência nº \d+\/\d{4}/.test(document.querySelector('main')?.innerText || ''), null, { timeout: 30000 });
      const brutos = await page.evaluate(() => {
        const main = document.querySelector('main');
        const linhas = main.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        const editais = [...main.querySelectorAll('a')].filter(a => /^Edital/i.test(a.textContent.trim()));
        const marcos = [...main.querySelectorAll('*')].filter(el =>
          /^Audiência nº \d+\/\d{4}/.test((el.textContent || '').trim()) && ![...el.children].some(ch => /^Audiência nº/.test((ch.textContent || '').trim())));
        return marcos.map(el => {
          const linha = el.textContent.trim().replace(/\s+/g, ' ');
          const i = linhas.findIndex(l => l.replace(/\s+/g, ' ') === linha);
          const edital = editais.find(a => el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
          return { linha, tema: i >= 0 ? linhas[i + 1] : '', edital: edital ? edital.href : '' };
        });
      });
      itens.push(...extrairAudiencias(brutos, anoAudiencias));
    } catch (err) {
      falhas.push(`Audiências: ${resumirErro(err)}`);
    }
  } finally {
    await browser.close();
  }
  if (falhas.length === FONTES.length + 1) throw new Error(falhas.join('; '));
  return { itens, falhas };
}

module.exports = { capturarAnbima, extrairLista, extrairAudiencias, FONTES };
