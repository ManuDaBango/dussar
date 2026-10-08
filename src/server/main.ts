// Starts the real server:  npm start
// Settings come from environment variables so the same code works on your laptop and on a host:
//   PORT        which port to listen on          (default 3000)
//   DUSSAR_DB   where to keep the saved games    (default ./data/dussar.db)
//   BOT_DELAY_MS how long a computer player "thinks" (default 1000)
import { fileURLToPath } from 'node:url';
import { startServer } from './server';
import { SqliteStore } from './store';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DUSSAR_DB ?? './data/dussar.db';
const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

const botDelayMs = process.env.BOT_DELAY_MS ? Number(process.env.BOT_DELAY_MS) : undefined;

const app = await startServer({ port, store: new SqliteStore(dbPath), publicDir, botDelayMs });
console.log(`Dussar is running: open http://localhost:${app.port}`);
