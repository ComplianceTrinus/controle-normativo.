'use strict';
// Importa o backup exportado do piloto no claude.ai (ou de outra instalação).
// Idempotente: registros que já existem (mesmo id ou mesma norma) são mantidos como estão.
const fs = require('fs');
const crypto = require('crypto');
const { migrar, tx } = require('./db');
const { COLECOES, paraColunas } = require('./colecoes');

async function importarBackup(arquivo, { log = console } = {}) {
  const backup = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const c = backup.colecoes || {};
  await migrar();
  const cont = { normas: 0, acoes: 0, obrigacoes: 0, auditoria: 0, sistema: 0 };

  await tx(async db => {
    for (const col of ['normas', 'acoes', 'obrigacoes']) {
      const def = COLECOES[col];
      for (const doc of c[col] || []) {
        const { id, evidencias, historico, ...dados } = doc;
        const cols = paraColunas(col, dados);
        // carimbos originais
        cols.criado_em = doc.criadoEm || new Date().toISOString();
        cols.criado_por = doc.criadoPor || null;
        cols.atualizado_em = doc.atualizadoEm || cols.criado_em;
        cols.atualizado_por = doc.atualizadoPor || null;
        const nomes = Object.keys(cols);
        const r = await db.query(
          `INSERT INTO ${def.tabela} (id, ${nomes.join(', ')}) VALUES ($1, ${nomes.map((_, i) => '$' + (i + 2)).join(', ')})
           ON CONFLICT DO NOTHING`, [id, ...nomes.map(n => cols[n])]);
        cont[col] += r.rowCount;
        if (col === 'obrigacoes' && r.rowCount) {
          for (const h of historico || []) {
            await db.query('INSERT INTO obrigacao_envios (obrigacao_id, data, vencimento, obs, por) VALUES ($1,$2,$3,$4,$5)',
              [id, h.data, h.vencimento || null, h.obs || '', h.por || null]);
          }
        }
        if (col === 'acoes' && (evidencias || []).length) {
          log.warn(`Ação ${id}: ${evidencias.length} evidência(s) não migradas automaticamente (arquivos ficam no claude.ai). Baixe e reenvie pela tela.`);
        }
      }
    }
    for (const a of c.auditoria || []) {
      const r = await db.query(
        'INSERT INTO auditoria (id, em, por, acao, tipo, ref, detalhe) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [a.id || crypto.randomUUID(), a.em || new Date().toISOString(), a.por || null, a.acao || 'Importou', a.tipo || '', a.ref || '', a.detalhe || '']);
      cont.auditoria += r.rowCount;
    }
    for (const s of c.sistema || []) {
      const { id, ...dados } = s;
      const r = await db.query('INSERT INTO sistema (id, dados) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, dados]);
      cont.sistema += r.rowCount;
    }
    if (Object.values(cont).some(n => n > 0)) await db.query('INSERT INTO auditoria (id, por, acao, tipo, ref, detalhe) VALUES ($1, NULL, $2, $3, $4, $5)',
      [crypto.randomUUID(), 'Importou', 'Sistema', `Backup ${arquivo.split(/[\\/]/).pop()}`,
        `Normas ${cont.normas}; ações ${cont.acoes}; obrigações ${cont.obrigacoes}; eventos de auditoria ${cont.auditoria}`]);
  });
  log.log('Importação concluída:', cont);
  return cont;
}

module.exports = { importarBackup };
