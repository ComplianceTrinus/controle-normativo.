'use strict';
// Banco Central / CMN — API pública da Busca de normas (https://www.bcb.gov.br/estabilidadefinanceira/buscanormas)
const { chave, numeroComPonto, dataSP, limpa, buscar } = require('./util');

// Tipos acompanhados (Comunicados e atos administrativos ficam de fora)
const MAPA = {
  'Resolução BCB': { orgao: 'BACEN', tipo: 'Resolução', sigla: 'bcb-res' },
  'Resolução CMN': { orgao: 'CMN', tipo: 'Resolução', sigla: 'cmn-res' },
  'Resolução Conjunta': { orgao: 'BACEN', tipo: 'Resolução Conjunta', sigla: 'bcb-rc' },
  'Instrução Normativa BCB': { orgao: 'BACEN', tipo: 'Instrução Normativa', sigla: 'bcb-in' },
  'Circular': { orgao: 'BACEN', tipo: 'Circular', sigla: 'bcb-circ' },
  'Carta Circular': { orgao: 'BACEN', tipo: 'Carta Circular', sigla: 'bcb-cc' },
};

function urlBusca(desde) {
  return 'https://www.bcb.gov.br/api/search/app/normativos/buscanormativos'
    + '?querytext=ContentType:normativo%20AND%20contentSource:normativos'
    + '&rowlimit=200&startrow=0&sortlist=Data1OWSDATE:descending'
    + `&refinementfilters=Data:range(datetime(${desde}),datetime(max))`;
}

function mapear(linhas) {
  const out = [];
  for (const r of linhas || []) {
    const m = MAPA[r.TipodoNormativoOWSCHCS];
    if (!m) continue;
    const n = Math.round(parseFloat(r.NumeroOWSNMBR));
    if (!Number.isFinite(n)) continue;
    const numero = numeroComPonto(n);
    out.push({
      id: `${m.sigla}-${n}`,
      orgao: m.orgao,
      tipo: m.tipo,
      numero,
      chave: chave(m.orgao, m.tipo, numero),
      dataPublicacao: r.data ? dataSP(r.data) : '',
      ementa: limpa(String(r.AssuntoNormativoOWSMTXT || '').replace(/<[^>]+>/g, ' ')),
      tema: '',
      link: 'https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo='
        + encodeURIComponent(r.TipodoNormativoOWSCHCS) + '&numero=' + n,
      observacoes: r.ResponsavelOWSText ? `Unidade responsável no BCB: ${r.ResponsavelOWSText}.` : '',
      origem: 'Captura automática — Busca de normas BCB',
    });
  }
  return out;
}

async function capturarBcb(desde) {
  const j = await buscar(urlBusca(desde), { tipo: 'json' });
  if (!j || !Array.isArray(j.Rows)) throw new Error('Resposta inesperada da API do Banco Central');
  return mapear(j.Rows);
}

module.exports = { capturarBcb, mapear, urlBusca };
