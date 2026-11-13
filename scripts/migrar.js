'use strict';
// Cria/atualiza as tabelas no PostgreSQL.  Uso: npm run migrar
const { migrar, pool } = require('../src/db');

migrar()
  .then(() => { console.log('Esquema do banco aplicado com sucesso.'); return pool.end(); })
  .catch(err => { console.error('Falha ao aplicar o esquema:', err.message); process.exit(1); });
