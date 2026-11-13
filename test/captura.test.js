'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mapear } = require('../src/captura/bcb');
const { extrair } = require('../src/captura/cvm');
const { extrairLista, extrairAudiencias, FONTES } = require('../src/captura/anbima');
const { chave, numeroComPonto, somarDias, dataSP } = require('../src/captura/util');

test('chave igual à da tela', () => {
  assert.strictEqual(chave('BACEN', 'Resolução', '604'), 'bacen|resolucao|604');
  assert.strictEqual(chave('CMN', 'Resolução', '5.344'), 'cmn|resolucao|5344');
  assert.strictEqual(chave('ANBIMA', 'Audiência Pública', '2/2026'), 'anbima|audiencia publica|22026');
  assert.strictEqual(numeroComPonto(5344), '5.344');
  assert.strictEqual(numeroComPonto(604), '604');
  assert.strictEqual(somarDias('2026-11-01', -3), '2026-10-29');
  assert.strictEqual(dataSP('2026-10-30T01:00:05Z'), '2026-10-29');
});

test('Banco Central: filtra tipos e monta link oficial', () => {
  const rows = [
    { TipodoNormativoOWSCHCS: 'Resolução CMN', NumeroOWSNMBR: '5344.00000000000', data: '2026-10-29T21:00:05Z', AssuntoNormativoOWSMTXT: '<div class="x">Altera o anexo à Resolução CMN nº 4.995.</div>', ResponsavelOWSText: 'SECRE' },
    { TipodoNormativoOWSCHCS: 'Comunicado', NumeroOWSNMBR: '46217.0', data: '2026-11-03T13:05:28Z', AssuntoNormativoOWSMTXT: 'Divulga nomes', ResponsavelOWSText: 'DEORF' },
    { TipodoNormativoOWSCHCS: 'Instrução Normativa BCB', NumeroOWSNMBR: '785.000000000000', data: '2026-10-23T20:45:00Z', AssuntoNormativoOWSMTXT: 'Altera leiaute DDR', ResponsavelOWSText: 'DESIG' },
    { TipodoNormativoOWSCHCS: 'Ato do Presidente', NumeroOWSNMBR: '1392.0', data: '2026-10-29T10:37:17Z', AssuntoNormativoOWSMTXT: 'Liquidação', ResponsavelOWSText: 'SECRE' },
  ];
  const r = mapear(rows);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual([r[0].id, r[0].orgao, r[0].numero, r[0].chave, r[0].dataPublicacao], ['cmn-res-5344', 'CMN', '5.344', 'cmn|resolucao|5344', '2026-10-29']);
  assert.strictEqual(r[0].ementa, 'Altera o anexo à Resolução CMN nº 4.995.');
  assert.match(r[0].link, /tipo=Resolu%C3%A7%C3%A3o%20CMN&numero=5344$/);
  assert.strictEqual(r[1].id, 'bcb-in-785');
});

test('CVM: lê a lista "Mais Recentes"', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'cvm-resolucoes.html'), 'utf8');
  const r = extrair(html);
  assert.strictEqual(r.length, 3); // ignora o bloco "Destaques"
  assert.ok(!r.some(x => x.id === 'cvm-res-160'));
  assert.deepStrictEqual([r[0].id, r[0].dataPublicacao, r[0].ementa], ['cvm-res-248', '2026-10-13', 'Altera a Resolução CVM nº 67, de 10 de março de 2022.']);
  assert.ok(r[1].ementa.startsWith('Institui, em caráter experimental'));
  assert.ok(!r[1].ementa.includes('Publicada'));
  assert.strictEqual(r[2].link, 'https://conteudo.cvm.gov.br/legislacao/resolucoes/resol050.html');
  assert.strictEqual(r[2].chave, 'cvm|resolucao|50');
});

test('ANBIMA: circulares e audiências', () => {
  const links = [
    { t: 'Circular nº 2026/000030 - 29/10/2026', h: 'https://www.anbima.com.br/x/2026-000030.htm' },
    { t: 'Circular nº 2026/000029 - 21/10/2026', h: 'https://www.anbima.com.br/x/2026-000029.htm' },
    { t: 'Próxima página', h: '#' },
  ];
  const texto = 'Ano\n2026\nBuscar\nCircular nº 2026/000030 - 29/10/2026\nInstituições terão mais tempo para adequar suas equipes à C-Pro R\nCircular nº 2026/000029 - 21/10/2026\nParticipe do novo grupo de trabalho\n1\n2';
  const r = extrairLista(links, texto, FONTES[0]);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual([r[0].id, r[0].numero, r[0].dataPublicacao, r[0].chave], ['anbima-circ-2026-000030', '2026/000030', '2026-10-29', 'anbima|circular|2026000030']);
  assert.strictEqual(r[0].ementa, 'Instituições terão mais tempo para adequar suas equipes à C-Pro R');

  const a = extrairAudiencias([
    { linha: 'Audiência nº 2/2026 | Código de Processos', tema: 'Aprimoramentos no processo sancionador', edital: 'https://www.anbima.com.br/edital.pdf' },
    { linha: 'Audiência nº 3/2025 | Código de Distribuição', tema: 'Tema antigo', edital: '' },
  ], 2026);
  assert.strictEqual(a.length, 1);
  assert.deepStrictEqual([a[0].id, a[0].chave, a[0].ementa], ['anbima-aud-2-2026', 'anbima|audiencia publica|22026', 'Código de Processos: Aprimoramentos no processo sancionador']);

  // Caso real da página (03/11/2026): a audiência 1/2026 aparece duas vezes e a linha seguinte repete o título
  const real = extrairAudiencias([
    { linha: 'Audiência nº 1/2026 | Código de Administração e Gestão de Recursos de Terceiros | Código de Distribuição', tema: 'Audiência nº 1/2026 | Código de Ofertas Públicas', edital: 'https://x/Edital_Saneamento_2026.pdf' },
    { linha: 'Audiência nº 1/2026 | Código de Ofertas Públicas', tema: 'Aditamento Edital Saneamento 01/2026', edital: 'https://x/Edital_Saneamento_2026.pdf' },
    { linha: 'Audiência nº 5/2025 | Código de Serviços Qualificados', tema: '', edital: 'https://x/Edital_SQ.pdf' },
  ], 2026);
  assert.strictEqual(real.length, 1);
  assert.strictEqual(real[0].ementa, 'Código de Administração e Gestão de Recursos de Terceiros | Código de Distribuição');
  assert.strictEqual(real[0].link, 'https://x/Edital_Saneamento_2026.pdf');
});
