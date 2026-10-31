import 'dotenv/config';
import { createApp } from './app.js';
import { createPool } from './db.js';

const pool = createPool(process.env.DATABASE_URL);
const port = Number(process.env.PORT) || 4000;

createApp(pool, { corsOrigin: process.env.CORS_ORIGIN }).listen(port, () => {
  console.log(`RFQ auction API listening on http://localhost:${port}/api`);
});
