// Apply docs/schema.sql (idempotent: CREATE ... IF NOT EXISTS).
// Usage: npm run migrate   (uses DIRECT_URL)

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.js';

const SCHEMA_FILE = fileURLToPath(new URL('../../docs/schema.sql', import.meta.url));

export async function applySchema(pool) {
  const sql = await readFile(SCHEMA_FILE, 'utf8');
  // Statements run in order, so tables below land in the schema created here.
  const create = pool.schema === 'public' ? '' : `CREATE SCHEMA IF NOT EXISTS ${pool.schema};\n`;
  await pool.query(create + sql);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(process.env.DIRECT_URL);
  try {
    await applySchema(pool);
    console.log(`Schema applied to "${pool.schema}".`);
  } finally {
    await pool.end();
  }
}
