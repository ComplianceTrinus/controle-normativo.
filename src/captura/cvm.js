'use strict';
// CVM — listas "Mais Recentes" das páginas de legislação (HTML pronto no servidor):
//   Resoluções, Ofícios-Circulares, Pareceres de Orientação e Deliberações.
// Cada página tem dois blocos com a mesma classe: "Destaques" (antigos) e "Mais Recentes".
const cheerio = require('cheerio');
const { chave, brParaIso, limpa, buscar } = require('./util');

const BASE = 'https://conteudo.cvm.gov.br';
const URL_LISTA = `${BASE}/legislacao/resolucoes.html`;

// Ofícios-Circulares mudaram de formato ao longo dos anos:
//   "Ofício-Circular nº 1/2026/CVM/SOI", "Ofício Circular CVM/SSE 03/26", "Ofício Circular Anual 2026 CVM/SRE"
// Todos viram "n/aaaa/CVM/SUP" (ou "Anual aaaa/CVM/SUP"), para a chave não duplicar.
function numeroOficio(titulo, href) {
  const t = limpa(titulo);
  let m = t.match(/n[º°o.]?\s*(\d+)\s*\/\s*(\d{4})\s*\/\s*CVM\s*\/\s*([A-Z0-9]+)/i);
  if (m) return `${Number(m[1])}/${m[2]}/CVM/${m[3].toUpperCase()}`;
  m = t.match(/Anual\s*(\d{4})\s*(?:\/?\s*CVM)?\s*\/\s*([A-Z0-9]+)/i) || t.match(/Anual\s*CVM\s*\/\s*([A-Z0-9]+)\s*(\d{4})/i);
  if (m) {
    const [ano, sup] = /^\d{4}$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    return `Anual ${ano}/CVM/${sup.toUpperCase()}`;
  }
  m = t.match(/CVM\s*\/\s*([A-Z0-9]+)\s*n?[º°o.]?\s*(\d{1,3})\s*\/\s*(\d{2,4})/i);
  if (m) {
    const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${Number(m[2])}/${ano}/CVM/${m[1].toUpperCase()}`;
  }
  return (String(href || '').match(/([^/]+)\.html?$/) || [, t])[1];
}

const PAGINAS = [
  {
    nome: 'Resoluções', tipo: 'Resolução', prefixo: 'res', url: URL_LISTA, filtraData: false,
    numero: (titulo, href) => { const m = href.match(/resol(\d+)\.html/); return m ? String(Number(m[1])) : null; },
    link: (href, numero) => `${BASE}/legislacao/resolucoes/resol${numero.padStart(3, '0')}.html`,
    seletor: 'a[href*="/legislacao/resolucoes/resol"]',
  },
  {
    nome: 'Ofícios-Circulares', tipo: 'Ofício Circular', prefixo: 'oc', url: `${BASE}/legislacao/oficios-circulares.html`, filtraData: true,
    numero: numeroOficio,
    seletor: 'a[href*="/legislacao/oficios-circulares/"]',
  },
  {
    nome: 'Pareceres de Orientação', tipo: 'Parecer de Orientação', prefixo: 'po', url: `${BASE}/legislacao/pareceres-orientacao.html`, filtraData: true,
    numero: (titulo, href) => { const m = limpa(titulo).match(/(\d+)\s*$/) || href.match(/pare0*(\d+)\.html/); return m ? String(Number(m[1])) : null; },
    seletor: 'a[href*="/legislacao/pareceres-orientacao/"]',
  },
  {
    nome: 'Deliberações', tipo: 'Deliberação', prefixo: 'del', url: `${BASE}/legislacao/deliberacoes.html`, filtraData: true,
    numero: (titulo, href) => { const m = limpa(titulo).match(/(\d+)\s*$/) || href.match(/deli0*(\d+)\.html/); return m ? String(Number(m[1])) : null; },
    seletor: 'a[href*="/legislacao/deliberacoes/"]',
  },
];

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function extrair(html, pagina = PAGINAS[0]) {
  const $ = cheerio.load(html);
  const out = [];
  const vistos = new Set();
  let blocos = $('.contentMaisRecentes').filter((_, el) => /Mais Recentes/i.test($(el).find('h3').first().text()));
  if (!blocos.length) blocos = $('.contentMaisRecentes');
  blocos.find('li').each((_, li) => {
    const a = $(li).find(pagina.seletor).first();
    const href = String(a.attr('href') || '');
    if (!href) return;
    const titulo = limpa(a.text()) || limpa($(li).find('b').first().text());
    const numero = pagina.numero(titulo, href);
    if (!numero) return;
    const k = chave('CVM', pagina.tipo, numero);
    if (vistos.has(k)) return;
    vistos.add(k);
    const texto = limpa($(li).text());
    const data = brParaIso((texto.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0]);
    let ementa = limpa($(li).find('div').first().text());
    ementa = ementa.replace(/\(Publicad[ao] no DOU[\s\S]*$/i, '').replace(/- Resolução CVM \d+:[\s\S]*$/i, '').trim();
    out.push({
      id: `cvm-${pagina.prefixo}-${slug(numero)}`,
      orgao: 'CVM',
      tipo: pagina.tipo,
      numero,
      chave: k,
      dataPublicacao: data,
      ementa: ementa || `${pagina.tipo} CVM ${numero}`,
      tema: '',
      link: pagina.link ? pagina.link(href, numero) : new URL(href, BASE).href,
      observacoes: '',
      origem: 'Captura automática — CVM',
    });
  });
  return out;
}

// Devolve um array (compatível com a versão anterior) com a propriedade "falhas".
// "desde" (AAAA-MM-DD) descarta itens antigos que ainda aparecem em "Mais Recentes"
// nas páginas de Ofícios, Pareceres e Deliberações. As Resoluções seguem como antes.
async function capturarCvm({ desde = '' } = {}) {
  const itens = [];
  const falhas = [];
  for (const p of PAGINAS) {
    try {
      const lista = extrair(await buscar(p.url), p);
      if (!lista.length) throw new Error('nenhum item encontrado (o layout pode ter mudado)');
      itens.push(...lista.filter(x => !p.filtraData || !desde || !x.dataPublicacao || x.dataPublicacao >= desde));
    } catch (err) {
      falhas.push(`${p.nome}: ${err.message}`);
    }
  }
  if (falhas.length === PAGINAS.length) throw new Error(falhas.join(' | '));
  itens.falhas = falhas;
  return itens;
}

module.exports = { capturarCvm, extrair, numeroOficio, PAGINAS, URL_LISTA };
