// Thin database layer: Postgres in production (DATABASE_URL set),
// Node's built-in SQLite locally so the app runs with zero setup.
// All queries use $1-style placeholders; they are rewritten for SQLite.

const usePg = Boolean(process.env.DATABASE_URL);

const ID = usePg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const REAL = usePg ? 'DOUBLE PRECISION' : 'REAL';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id ${ID},
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // A coffee bean or a tea. `variety` is the roast level for coffee, the tea type for tea.
  `CREATE TABLE IF NOT EXISTS items (
    id ${ID},
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('coffee', 'tea')),
    name TEXT NOT NULL,
    variety TEXT NOT NULL,
    origin TEXT,
    roast_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  )`,
  // `method` is the brew method for coffee, 'western' or 'gongfu' for tea.
  // `nonce` makes form submission idempotent (double-clicks do not create duplicates).
  `CREATE TABLE IF NOT EXISTS brews (
    id ${ID},
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    dose_g ${REAL} NOT NULL,
    water_ml ${REAL} NOT NULL,
    grind TEXT,
    temp_c ${REAL} NOT NULL,
    temp_cue TEXT,
    time_s INTEGER NOT NULL,
    infusion INTEGER NOT NULL DEFAULT 1,
    taste TEXT NOT NULL,
    strength TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    notes TEXT,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, nonce)
  )`,
  'CREATE INDEX IF NOT EXISTS brews_item_idx ON brews (item_id, created_at)',
  'CREATE INDEX IF NOT EXISTS items_user_idx ON items (user_id)',
];

let query;

if (usePg) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  query = async (sql, params = []) => (await pool.query(sql, params)).rows;
} else {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const db = new DatabaseSync(process.env.SQLITE_FILE || path.join(__dirname, '..', 'brew-journal.db'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  query = async (sql, params = []) => {
    const stmt = db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    const returnsRows = /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
    if (returnsRows) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

async function init() {
  for (const statement of SCHEMA) await query(statement);
}

async function one(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /UNIQUE constraint failed/i.test(err.message || ''));
}

module.exports = { query, one, init, isUniqueViolation, usePg };
