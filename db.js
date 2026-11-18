'use strict';
// Persistence layer. Uses Postgres when DATABASE_URL is set, otherwise
// falls back to an in-memory store so the game runs locally with zero setup.

const { Pool } = require('pg');

let pool = null;
const mem = { rounds: [], species: {} };
let pending = {}; // species -> count, flushed periodically
let cache = null;
let cacheAt = 0;
const CACHE_MS = 10_000;

async function init() {
  if (!process.env.DATABASE_URL) {
    console.log('[db] DATABASE_URL not set, using in-memory store');
    return;
  }
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    pool.on('error', (e) => console.error('[db] pool error', e.message));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS round_scores (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        score       INTEGER NOT NULL,
        best_catch  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS round_scores_score_idx ON round_scores (score DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS round_scores_created_idx ON round_scores (created_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS species_totals (
        species TEXT PRIMARY KEY,
        total   BIGINT NOT NULL DEFAULT 0
      )`);
    console.log('[db] postgres ready');
  } catch (e) {
    console.error('[db] postgres init failed, falling back to memory:', e.message);
    pool = null;
  }
  setInterval(() => flush().catch((e) => console.error('[db] flush', e.message)), 10_000).unref();
}

function addCatch(species, n) {
  pending[species] = (pending[species] || 0) + n;
  if (!pool) {
    mem.species[species] = (mem.species[species] || 0) + n;
    pending = {};
  }
}

async function flush() {
  const keys = Object.keys(pending);
  if (!pool || keys.length === 0) return;
  const counts = keys.map((k) => pending[k]);
  pending = {};
  try {
    await pool.query(
      `INSERT INTO species_totals (species, total)
       SELECT * FROM unnest($1::text[], $2::bigint[])
       ON CONFLICT (species) DO UPDATE SET total = species_totals.total + EXCLUDED.total`,
      [keys, counts]
    );
  } catch (e) {
    // put them back so they are retried
    keys.forEach((k, i) => (pending[k] = (pending[k] || 0) + counts[i]));
    throw e;
  }
}

async function saveRound(rows) {
  cache = null;
  if (rows.length === 0) return;
  if (!pool) {
    const now = new Date().toISOString();
    rows.forEach((r) => mem.rounds.push({ ...r, created_at: now }));
    mem.rounds.sort((a, b) => b.score - a.score);
    mem.rounds.length = Math.min(mem.rounds.length, 500);
    return;
  }
  await pool.query(
    `INSERT INTO round_scores (name, score, best_catch)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[])`,
    [rows.map((r) => r.name), rows.map((r) => r.score), rows.map((r) => r.best_catch)]
  );
}

async function leaderboard(force) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  let result;
  if (!pool) {
    const dayAgo = Date.now() - 86_400_000;
    result = {
      allTime: mem.rounds.slice(0, 10),
      today: mem.rounds.filter((r) => Date.parse(r.created_at) > dayAgo).slice(0, 5),
      species: { ...mem.species },
      rounds: mem.rounds.length,
      persistent: false,
    };
  } else {
    const [all, today, sp, cnt] = await Promise.all([
      pool.query(`SELECT name, score, best_catch, created_at FROM round_scores ORDER BY score DESC, created_at ASC LIMIT 10`),
      pool.query(`SELECT name, score, best_catch, created_at FROM round_scores
                  WHERE created_at > now() - interval '24 hours' ORDER BY score DESC LIMIT 5`),
      pool.query(`SELECT species, total FROM species_totals`),
      pool.query(`SELECT count(*)::int AS n FROM round_scores`),
    ]);
    const species = {};
    sp.rows.forEach((r) => (species[r.species] = Number(r.total)));
    result = { allTime: all.rows, today: today.rows, species, rounds: cnt.rows[0].n, persistent: true };
  }
  cache = result;
  cacheAt = Date.now();
  return result;
}

async function close() {
  try { await flush(); } catch (e) { /* ignore */ }
  if (pool) await pool.end().catch(() => {});
}

module.exports = { init, addCatch, saveRound, leaderboard, flush, close };
