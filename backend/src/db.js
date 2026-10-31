import pg from 'pg';

// DATE columns (service_date, quote_valid_until) stay as 'YYYY-MM-DD' strings
// instead of becoming local-midnight Date objects.
pg.types.setTypeParser(1082, (value) => value);
// bigint identity columns (seq) are far below 2^53; parse as numbers so they sort numerically.
pg.types.setTypeParser(20, (value) => Number(value));

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Create a pg Pool from a Postgres URL. Supports a `?schema=<name>` parameter
 * (which pg itself ignores) by setting search_path on every new connection.
 */
export function createPool(connectionString) {
  if (!connectionString) throw new Error('Database URL is not set. Fill it in backend/.env.');

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    // Never echo the URL: it contains the password.
    throw new Error(
      'Database URL is malformed. Wrap it in double quotes in .env and URL-encode special ' +
        'characters in the password (e.g. ? -> %3F, # -> %23, @ -> %40, * -> %2A).'
    );
  }
  const schema = url.searchParams.get('schema');
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  url.searchParams.delete('schema');
  url.searchParams.delete('sslmode');

  const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname);
  const pool = new pg.Pool({
    connectionString: url.toString(),
    // Supabase requires TLS; its certificate chain is not in Node's default CA store.
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    // Only this schema: if it is missing, queries fail instead of silently
    // falling back to public (dev data). applySchema() creates it.
    ...(schema && { options: `-c search_path=${schema}` }),
  });
  pool.schema = schema ?? 'public';
  // The Supabase pooler closes idle connections. Without this handler that
  // 'error' event crashes the process; pg reconnects on the next query.
  pool.on('error', (err) => console.warn(`Idle database connection closed: ${err.message}`));
  return pool;
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
