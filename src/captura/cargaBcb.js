'use strict';
// Carga histórica (executada uma vez pelo Admin): normas do Banco Central e do CMN EM VIGOR,
// pela mesma API pública da Busca de normas usada na captura diária. Só acrescenta; nunca altera.
const { tx } = require('../db');
const { registrarAuditoria } = require('../colecoes');
const { buscar } = require('./util');
const { mapear } = require('./bcb');

const TIPOS = ['Resolução BCB', 'Resolução CMN', 'Resolução', 'Resolução Conjunta', 'Instrução Normativa BCB', 'Circular',
  'Carta Circular', 'Instrução Normativa Conjunta', 'Ato Normativo Conjunto', 'Decisão Conjunta', 'Portaria Conjunta'];
const POR_PAGINA = 200;

function urlPagina(tipo, inicio) {
  const consulta = `ContentType:normativo AND contentSource:normativos AND TipodoNormativoOWSCHCS:"${tipo}" AND RevogadoOWSBOOL:0 AND CanceladoOWSBOOL:0`;
  return 'https://www.bcb.gov.br/api/search/app/normativos/buscanormativos?querytext=' + encodeURIComponent(consulta)
    + `&rowlimit=${POR_PAGINA}&startrow=${inicio}&sortlist=` + encodeURIComponent('Data1OWSDATE:descending');
}

const cite = n => `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;

// Processa uma página de um tipo. Devolve o que entrou e onde continuar.
async function cargaPagina(tipo, inicio, usuarioId) {
  if (!TIPOS.includes(tipo)) throw Object.assign(new Error('Tipo de norma inválido.'), { status: 400 });
  inicio = Math.max(0, parseInt(inicio, 10) || 0);
  const j = await buscar(urlPagina(tipo, inicio), { tipo: 'json' });
  if (!j || !Array.isArray(j.Rows)) throw new Error('Resposta inesperada da API do Banco Central');
  // Só o tipo pedido e só o que está em vigor (confere de novo, além do filtro da busca)
  const linhas = j.Rows.filter(r => r.TipodoNormativoOWSCHCS === tipo && String(r.RevogadoOWSBOOL) !== '1' && String(r.CanceladoOWSBOOL) !== '1');
  const itens = mapear(linhas).map(n => ({
    ...n,
    origem: 'Carga histórica — Busca de normas BCB (em vigor)',
  }));
  const inseridas = [];
  await tx(async c => {
    for (const n of itens) {
      const r = await c.query(
        `INSERT INTO normas (id, orgao, tipo, numero, chave, data_publicacao, ementa, tema, link, status, criticidade,
                             observacoes, origem, criado_em, criado_por, atualizado_em, atualizado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Nova','Média',$10,$11,now(),$12,now(),$12)
         ON CONFLICT DO NOTHING`,
        [n.id, n.orgao, n.tipo, n.numero, n.chave, n.dataPublicacao || null, n.ementa || '(sem ementa na Busca de normas)', n.tema, n.link, n.observacoes, n.origem, usuarioId]);
      if (r.rowCount) inseridas.push(cite(n));
    }
    if (inseridas.length) {
      await registrarAuditoria({
        acao: 'Importou', tipo: 'Norma', ref: `Carga histórica BCB: ${inseridas.length} ${tipo}`,
        detalhe: inseridas.slice(0, 30).join('; ') + (inseridas.length > 30 ? `; e mais ${inseridas.length - 30}` : ''),
      }, usuarioId, c);
    }
  });
  const lidas = j.Rows.length;
  const proximo = lidas === POR_PAGINA && inicio + lidas < (j.TotalRows || 0) ? inicio + lidas : null;
  return { tipo, total: j.TotalRows || 0, lidas, emVigor: itens.length, inseridas: inseridas.length, jaExistiam: itens.length - inseridas.length, proximo };
}

module.exports = { TIPOS, cargaPagina };
