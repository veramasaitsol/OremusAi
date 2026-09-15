// Side-effecting env loader, imported FIRST by server.js so the right .env file
// is loaded before any route module reads process.env. dotenv only reads `.env`
// by default; in production load `.env.production` (where the prod OAuth creds live).
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(__dirname, process.env.NODE_ENV === 'production' ? '.env.production' : '.env'),
});
