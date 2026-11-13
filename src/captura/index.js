'use strict';
// Orquestra a captura diária: Banco Central, CVM e ANBIMA. Só ACRESCENTA normas novas.
const { pool, q, tx } = require('../db');
const { config } = require('../config');
const { lerSistema, gravarSistema, registrarAuditoria } = require('../colecoes');
const { capturarBcb } = require('./bcb');
const { capturarCvm } = require('./cvm');
const { capturarAnbima } = require('./anbima');
const { dataSP, somarDias } = require('./util');

const TRAVA = 735_001; // pg_advisory_lock: impede duas capturas ao mesmo tempo (várias instâncias)

const cite = n => `${n.tipo} ${n.orgao === 'BACEN' ? 'BCB' : n.orgao} nº ${n.numero}`;

async function executarCaptura({ origem = 'manual', log = console } = {}) {
  // A trava é por conexão: usa uma conexão dedicada do início ao fim
  const conexaoTrava = await pool.connect();
  const trava = await conexaoTrava.query('SELECT pg_try_advisory_lock($1) AS ok', [TRAVA]);
  if (!trava.rows[0].ok) { conexaoTrava.release(); log.log('[captura] outra execução em andamento; ignorando'); return { ignorada: true }; }
  try {
    const estado = (await lerSistema('captura')) || {};
    const hoje = dataSP();
    const inicial = config.captura.dataInicial || somarDias(hoje, -30);
    const desdeBcb = somarDias(estado.ultimaDataBcb || inicial, -3);
    const desdeAnbima = somarDias(estado.ultimaDataAnbima || inicial, -3);

    const fontesOk = [];
    const falhas = [];
    const itens = [];
    let maxBcb = estado.ultimaDataBcb || '';
    let maxAnbima = estado.ultimaDataAnbima || '';

    try {
      const b = await capturarBcb(desdeBcb);
      itens.push(...b);
      fontesOk.push('Banco Central');
      for (const x of b) if (x.dataPublicacao > maxBcb) maxBcb = x.dataPublicacao;
    } catch (err) { falhas.push('Banco Central: ' + err.message); }

    try {
      itens.push(...await capturarCvm());
      fontesOk.push('CVM');
    } catch (err) { falhas.push('CVM: ' + err.message); }

    if (config.captura.anbima) {
      try {
        const r = await capturarAnbima({ desde: desdeAnbima, anoAudiencias: Number(hoje.slice(0, 4)) });
        itens.push(...r.itens);
        fontesOk.push('ANBIMA');
        falhas.push(...r.falhas.map(f => 'ANBIMA ' + f));
        for (const x of r.itens) if (x.dataPublicacao > maxAnbima) maxAnbima = x.dataPublicacao;
      } catch (err) { falhas.push('ANBIMA: ' + err.message); }
    }

    const existentes = await q('SELECT id, chave FROM normas');
    const ids = new Set(existentes.rows.map(r => r.id));
    const chaves = new Set(existentes.rows.map(r => r.chave));
    const novos = [];
    for (const n of itens) {
      if (ids.has(n.id) || chaves.has(n.chave)) continue;
      ids.add(n.id); chaves.add(n.chave);
      novos.push(n);
    }

    const agora = new Date().toISOString();
    await tx(async c => {
      for (const n of novos) {
        await c.query(
          `INSERT INTO normas (id, orgao, tipo, numero, chave, data_publicacao, ementa, tema, link, status, criticidade,
                               observacoes, origem, criado_em, criado_por, atualizado_em, atualizado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Nova','Média',$10,$11,now(),NULL,now(),NULL)
           ON CONFLICT DO NOTHING`,
          [n.id, n.orgao, n.tipo, n.numero, n.chave, n.dataPublicacao || null, n.ementa, n.tema, n.link, n.observacoes, n.origem]);
      }
      const lista = novos.map(cite);
      await registrarAuditoria({
        acao: 'Capturou', tipo: 'Norma',
        ref: `${novos.length} ${novos.length === 1 ? 'norma nova' : 'normas novas'}`,
        detalhe: (lista.length ? lista.slice(0, 30).join('; ') + (lista.length > 30 ? `; e mais ${lista.length - 30}` : '') : 'Nenhuma norma nova')
          + (falhas.length ? ' · Falhas: ' + falhas.join(' | ') : '') + ` · Origem: ${origem}`,
      }, null, c);
      await gravarSistema('captura', {
        ultimaExecucao: agora,
        status: falhas.length ? (fontesOk.length ? 'parcial' : 'erro') : 'ok',
        novas: novos.length,
        fontes: fontesOk.length ? fontesOk.join(', ').replace(/, ([^,]*)$/, ' e $1') : 'nenhuma fonte',
        ultimaDataBcb: maxBcb || estado.ultimaDataBcb || '',
        ultimaDataAnbima: maxAnbima || estado.ultimaDataAnbima || '',
        detalhe: falhas.join(' | ').slice(0, 500),
      }, c);
    });

    const resumo = { novas: novos.length, normas: novos.map(cite), fontes: fontesOk, falhas };
    log.log('[captura]', JSON.stringify(resumo));
    return resumo;
  } finally {
    await conexaoTrava.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => {});
    conexaoTrava.release();
  }
}

module.exports = { executarCaptura };
