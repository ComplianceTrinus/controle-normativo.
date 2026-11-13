'use strict';
// CVM — lista "Mais Recentes" de https://conteudo.cvm.gov.br/legislacao/resolucoes.html (HTML pronto no servidor)
const cheerio = require('cheerio');
const { chave, brParaIso, limpa, buscar } = require('./util');

const URL_LISTA = 'https://conteudo.cvm.gov.br/legislacao/resolucoes.html';

function extrair(html) {
  const $ = cheerio.load(html);
  const out = [];
  const vistos = new Set();
  // A página tem dois blocos com a mesma classe: "Destaques" (normas antigas) e "Mais Recentes"
  let blocos = $('.contentMaisRecentes').filter((_, el) => /Mais Recentes/i.test($(el).find('h3').first().text()));
  if (!blocos.length) blocos = $('.contentMaisRecentes');
  blocos.find('li').each((_, li) => {
    const a = $(li).find('a[href*="/legislacao/resolucoes/resol"]').first();
    const m = String(a.attr('href') || '').match(/resol(\d+)\.html/);
    if (!m) return;
    const n = Number(m[1]);
    if (vistos.has(n)) return;
    vistos.add(n);
    const texto = limpa($(li).text());
    const data = brParaIso((texto.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0]);
    let ementa = limpa($(li).find('div').first().text());
    ementa = ementa.replace(/\(Publicada no DOU[\s\S]*$/i, '').replace(/- Resolução CVM \d+:[\s\S]*$/i, '').trim();
    const numero = String(n);
    out.push({
      id: `cvm-res-${n}`,
      orgao: 'CVM',
      tipo: 'Resolução',
      numero,
      chave: chave('CVM', 'Resolução', numero),
      dataPublicacao: data,
      ementa: ementa || `Resolução CVM nº ${n}`,
      tema: '',
      link: `https://conteudo.cvm.gov.br/legislacao/resolucoes/resol${String(n).padStart(3, '0')}.html`,
      observacoes: '',
      origem: 'Captura automática — CVM',
    });
  });
  return out;
}

async function capturarCvm() {
  const html = await buscar(URL_LISTA);
  const itens = extrair(html);
  if (!itens.length) throw new Error('Nenhuma resolução encontrada na página da CVM (o layout pode ter mudado)');
  return itens;
}

module.exports = { capturarCvm, extrair, URL_LISTA };
