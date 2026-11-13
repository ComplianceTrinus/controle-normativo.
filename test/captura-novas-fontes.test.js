'use strict';
// Leitores da CVM além das Resoluções (Ofícios-Circulares, Pareceres de Orientação e Deliberações)
// e atos conjuntos do Banco Central.
const test = require('node:test');
const assert = require('node:assert');
const { extrair, numeroOficio, PAGINAS } = require('../src/captura/cvm');

// Trechos reduzidos das páginas reais da CVM (13/11/2026): blocos "Destaques" e "Mais Recentes"
const FIXTURES = {
  "cvm-oficios.html": "<html><body><div class=\"contentMaisRecentes\"><h3>Destaques</h3><ul>\n<li><a href=\"/legislacao/oficios-circulares/sep/oc-anual-sep-2024.html\"><b>Ofício Circular Anual 2024 CVM/SEP</b></a><br><b>28/02/2024</b><br><div><p> Orientações gerais sobre procedimentos a serem observados pelas companhias abertas.</p></div></li>\n<li><a href=\"/legislacao/oficios-circulares/sep/oc-sep-0220.html\"><b>Ofício Circular CVM/SEP 02/20</b></a><br><b>27/02/2020</b><br><div><p> Orientações antigas.</p></div></li>\n</ul></div><div class=\"contentMaisRecentes\"><h3>Mais Recentes</h3><ul>\n<li><a href=\"/legislacao/oficios-circulares/soi/oc-soi-012026.html\"><b>Ofício-Circular nº 1/2026/CVM/SOI</b></a><br><b>10/11/2026</b><br><div><p> Novo Sistema de Atendimento ao Cidadão (SAC-CVM) – orientações sobre o recebimento e o tratamento de demandas encaminhadas às Ouvidorias.</p></div></li>\n<li><a href=\"/legislacao/oficios-circulares/smi/oc-smi-0426.html\"><b>Ofício Circular nº 4/2026/CVM/SMI</b></a><br><b>27/10/2026</b><br><div><p> Orienta os intermediários sobre procedimentos.</p></div></li>\n<li><a href=\"/legislacao/oficios-circulares/sre/oc-anual-2026-sre.html\"><b>Ofício Circular Anual 2026 CVM/SRE</b></a><br><b>14/09/2026</b><br><div><p> Orientações gerais sobre procedimentos a serem observados pelos emissores/ofertantes e intermediários em ofertas públicas de valores mobiliários.</p></div></li>\n<li><a href=\"/legislacao/oficios-circulares/sse1/oc-sse-0326.html\"><b>Ofício Circular CVM/SSE 03/26</b></a><br><b>11/09/2026</b><br><div><p> Impossibilidade de vinculação da taxa de performance de FIDC à remuneração.</p></div></li>\n<li><a href=\"/legislacao/oficios-circulares/sre/oc-sre-0525.html\"><b>Ofício Circular CVM/SRE 05/25</b></a><br><b>20/08/2025</b><br><div><p> Ofício antigo que ainda aparece na lista.</p></div></li>\n</ul></div></body></html>\n",
  "cvm-pareceres.html": "<html><body><div class=\"contentMaisRecentes\"><h3>Mais Recentes</h3><ul>\n<li><a href=\"/legislacao/pareceres-orientacao/pare041.html\"><b>Parecer de Orientação CVM 41</b></a><br><b>05/03/2026</b><br><div><p> Orientação sobre tokenização.</p></div></li>\n<li><a href=\"/legislacao/pareceres-orientacao/pare040.html\"><b>Parecer de Orientação CVM 40</b></a><br><b>11/10/2022</b><br><div><p> Criptoativos e o mercado de valores mobiliários.</p></div></li>\n</ul></div></body></html>\n",
  "cvm-deliberacoes.html": "<html><body><div class=\"contentMaisRecentes\"><h3>Destaques</h3><ul>\n<li><a href=\"/legislacao/deliberacoes/deli0400/deli498.html\"><b>Deliberação CVM 498</b></a><br><b>24/01/2006</b><br><div><p> Delega competência.</p></div></li>\n</ul></div><div class=\"contentMaisRecentes\"><h3>Mais Recentes</h3><ul>\n<li><a href=\"/legislacao/deliberacoes/deli0900/deli908.html\"><b>Deliberação CVM 908</b></a><br><b>27/10/2026</b><br><div><p> Altera a Deliberação CVM nº 498, de 24 de janeiro de 2006. (Publicada no DOU de 28/10/2026.)</p></div></li>\n<li><a href=\"/legislacao/deliberacoes/deli0900/deli907.html\"><b>Deliberação CVM 907</b></a><br><b>01/10/2026</b><br><div><p> Outra deliberação.</p></div></li>\n</ul></div></body></html>\n"
};
const fixture = nome => FIXTURES[nome];
const pagina = tipo => PAGINAS.find(p => p.tipo === tipo);

test('CVM: número dos Ofícios-Circulares em todos os formatos', () => {
  assert.strictEqual(numeroOficio('Ofício-Circular nº 1/2026/CVM/SOI'), '1/2026/CVM/SOI');
  assert.strictEqual(numeroOficio('Ofício Circular nº 4/2026/CVM/SMI'), '4/2026/CVM/SMI');
  assert.strictEqual(numeroOficio('Ofício Circular CVM/SSE 03/26'), '3/2026/CVM/SSE');
  assert.strictEqual(numeroOficio('Ofício Circular CVM/SRE 05/26'), '5/2026/CVM/SRE');
  assert.strictEqual(numeroOficio('Ofício Circular Anual 2026 CVM/SRE'), 'Anual 2026/CVM/SRE');
  assert.strictEqual(numeroOficio('Ofício Circular Anual CVM/SEP 2024'), 'Anual 2024/CVM/SEP');
  assert.strictEqual(numeroOficio('Título inesperado', '/legislacao/oficios-circulares/x/oc-x-0126.html'), 'oc-x-0126');
});

test('CVM: lê "Mais Recentes" dos Ofícios-Circulares', () => {
  const r = extrair(fixture('cvm-oficios.html'), pagina('Ofício Circular'));
  assert.strictEqual(r.length, 5); // ignora o bloco "Destaques"
  assert.deepStrictEqual(
    [r[0].id, r[0].tipo, r[0].numero, r[0].chave, r[0].dataPublicacao],
    ['cvm-oc-1-2026-cvm-soi', 'Ofício Circular', '1/2026/CVM/SOI', 'cvm|oficio circular|12026cvmsoi', '2026-11-10']);
  assert.ok(r[0].ementa.startsWith('Novo Sistema de Atendimento ao Cidadão'));
  assert.strictEqual(r[0].link, 'https://conteudo.cvm.gov.br/legislacao/oficios-circulares/soi/oc-soi-012026.html');
  assert.strictEqual(r[2].numero, 'Anual 2026/CVM/SRE');
  assert.strictEqual(r[3].numero, '3/2026/CVM/SSE');
  assert.ok(!r.some(x => x.numero.includes('SEP')));
});

test('CVM: Deliberações e Pareceres de Orientação', () => {
  const d = extrair(fixture('cvm-deliberacoes.html'), pagina('Deliberação'));
  assert.strictEqual(d.length, 2);
  assert.deepStrictEqual([d[0].id, d[0].numero, d[0].chave, d[0].dataPublicacao], ['cvm-del-908', '908', 'cvm|deliberacao|908', '2026-10-27']);
  assert.strictEqual(d[0].ementa, 'Altera a Deliberação CVM nº 498, de 24 de janeiro de 2006.');
  assert.strictEqual(d[0].link, 'https://conteudo.cvm.gov.br/legislacao/deliberacoes/deli0900/deli908.html');

  const p = extrair(fixture('cvm-pareceres.html'), pagina('Parecer de Orientação'));
  assert.strictEqual(p.length, 2);
  assert.deepStrictEqual([p[0].id, p[0].tipo, p[0].numero, p[0].chave], ['cvm-po-41', 'Parecer de Orientação', '41', 'cvm|parecer de orientacao|41']);
});

test('CVM: capturarCvm junta as páginas, filtra antigos e segue se uma página falhar', async () => {
  const util = require('../src/captura/util');
  const original = util.buscar;
  const paginas = {
    'resolucoes.html': null, // simula falha
    'oficios-circulares.html': fixture('cvm-oficios.html'),
    'pareceres-orientacao.html': fixture('cvm-pareceres.html'),
    'deliberacoes.html': fixture('cvm-deliberacoes.html'),
  };
  util.buscar = async url => {
    const html = paginas[url.split('/').pop()];
    if (!html) throw new Error('HTTP 503');
    return html;
  };
  delete require.cache[require.resolve('../src/captura/cvm')];
  try {
    const { capturarCvm } = require('../src/captura/cvm');
    const r = await capturarCvm({ desde: '2025-11-13' });
    assert.ok(Array.isArray(r));
    assert.deepStrictEqual(r.falhas, ['Resoluções: HTTP 503']);
    assert.strictEqual(r.filter(x => x.tipo === 'Ofício Circular').length, 4); // o de 2025 fica de fora
    assert.strictEqual(r.filter(x => x.tipo === 'Parecer de Orientação').length, 1); // o de 2022 fica de fora
    assert.strictEqual(r.filter(x => x.tipo === 'Deliberação').length, 2);
  } finally {
    util.buscar = original;
    delete require.cache[require.resolve('../src/captura/cvm')];
  }
});

test('Banco Central: atos conjuntos entram, Coremec, Coseg e atos administrativos não', () => {
  const { mapear } = require('../src/captura/bcb');
  const linha = (tipo, n) => ({ TipodoNormativoOWSCHCS: tipo, NumeroOWSNMBR: `${n}.0`, data: '2026-11-10T13:00:00Z', AssuntoNormativoOWSMTXT: 'Assunto', ResponsavelOWSText: 'DEREG' });
  const r = mapear([
    linha('Instrução Normativa Conjunta', 12),
    linha('Ato Normativo Conjunto', 3),
    linha('Decisão Conjunta', 21),
    linha('Portaria Conjunta', 7),
    linha('Resolução Coremec', 5),
    linha('Resolução Coseg', 2),
    linha('Ato de Diretor', 900),
  ]);
  assert.deepStrictEqual(r.map(x => x.id), ['bcb-inc-12', 'bcb-anc-3', 'bcb-dc-21', 'bcb-pc-7']);
  assert.deepStrictEqual(r.map(x => x.tipo), ['Instrução Normativa Conjunta', 'Ato Normativo Conjunto', 'Decisão Conjunta', 'Portaria Conjunta']);
  assert.strictEqual(r[0].chave, 'bacen|instrucao normativa conjunta|12');
  assert.match(r[2].link, /tipo=Decis%C3%A3o%20Conjunta&numero=21$/);
});
