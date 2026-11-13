'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const { config } = require('./config');

// DATE volta como texto AAAA-MM-DD (sem conversão de fuso)
types.setTypeParser(1082, v => v);

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  // No Vercel cada instância é pequena e de vida curta: poucas conexões por instância
  max: config.vercel ? 3 : 10,
});

const q = (texto, params) => pool.query(texto, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function migrar() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, q, tx, migrar };
