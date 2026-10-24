import { openDb } from './db.ts';
import { buildApp } from './app.ts';
import { createUser } from './auth.ts';

const db = await openDb();
const args = process.argv.slice(2);

if (args[0] === 'adduser') {
  const [, username, role, name, password] = args;
  if (!password) { console.error('usage: main.ts adduser <username> <role> "<full name>" <password>'); process.exit(2); }
  await createUser(db, { username, role: role as any, name, password });
  console.log(`created ${username}`);
  await db.close();
  process.exit(0);
}

if ((await db.query('select 1 from users limit 1')).rows.length === 0) {
  if (process.env.AROGYA_DEMO === '1') await (await import('./seed.ts')).seed(db);
  else if (process.env.AROGYA_ADMIN_PASSWORD) await createUser(db, { username: 'admin', name: 'Administrator', role: 'admin', password: process.env.AROGYA_ADMIN_PASSWORD });
  else console.warn('No users yet. Set AROGYA_ADMIN_PASSWORD (12+ characters) or AROGYA_DEMO=1, or run: node server/main.ts adduser admin admin "Administrator" <password>');
}

const app = await buildApp(db, { secureCookies: process.env.AROGYA_SECURE_COOKIES === '1' });
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`Arogya listening on http://${process.env.HOST ?? '127.0.0.1'}:${port}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await db.close(); process.exit(0); });
