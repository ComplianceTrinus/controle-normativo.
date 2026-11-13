'use strict';
// Importa o backup exportado do piloto no claude.ai (ou de outra instalação).
// Uso: npm run importar -- dados/backup-claude-2026-11-03.json
const { pool } = require('../src/db');
const { importarBackup } = require('../src/importacao');

const arquivo = process.argv[2];
if (!arquivo) { console.error('Informe o arquivo: npm run importar -- caminho/backup.json'); process.exit(1); }
importarBackup(arquivo)
  .then(() => pool.end())
  .catch(err => { console.error('Falha na importação:', err.message); process.exit(1); });
