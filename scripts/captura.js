'use strict';
// Executa a captura de normas uma vez (útil para testar ou agendar no cron do servidor).
// Uso: npm run captura
const { migrar, pool } = require('../src/db');
const { executarCaptura } = require('../src/captura');

(async () => {
  await migrar();
  const r = await executarCaptura({ origem: 'linha de comando' });
  console.log(r.ignorada ? 'Outra captura já está em andamento.'
    : `${r.novas} norma(s) nova(s). Fontes consultadas: ${r.fontes.join(', ') || 'nenhuma'}.`
      + (r.falhas.length ? `\nFalhas: ${r.falhas.join(' | ')}` : ''));
  await pool.end();
  process.exit(r.falhas && r.falhas.length && !r.fontes.length ? 2 : 0);
})().catch(err => { console.error(err); process.exit(1); });
