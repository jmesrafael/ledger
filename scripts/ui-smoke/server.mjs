// Throwaway local test server: serves the app from the repo, but the Supabase client is a stub that sends every rpc to an in-memory
// Postgres (PGlite) built from ALL migrations (applied + pending). Production is never contacted. Usage: node server.mjs <repo> <port>
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const repo = resolve(process.argv[2]), port = Number(process.argv[3] || 8099);
const { PGlite } = await import(pathToFileURL(join(repo, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const { pgcrypto } = await import(pathToFileURL(join(repo, 'node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js')).href);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
const mig = join(repo, 'supabase/migrations'), appl = join(mig, 'applied');
const files = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => join(appl, f)), ...readdirSync(mig).filter((f) => f.endsWith('.sql')).sort().map((f) => join(mig, f))];
for (const f of files) await db.exec(readFileSync(f, 'utf8'));
await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; update public.ledger_settings set value = '1000' where key = 'valuation_max_move'`);
await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
const call = async (fn, ...a) => { await db.exec('set role anon'); try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); } };
const A = (await call('login', 'raf', 'admin-password-1')).token;
const john = await call('admin_create_user', A, 'john', 'John Reyes', 'john-password', 0.1);
await call('admin_create_user', A, 'dino', 'Dino Cruz', 'dino-password', 0.1);
await call('admin_receive_deposit', A, john, 1000, 58, 58000, null, null, null, true);
await call('admin_post_equity', A, 1000, 58);
console.log('database ready:', files.length, 'migrations');

const STUB = `window.supabase = { createClient: () => ({
  rpc: async (fn, args) => { const r = await fetch('/rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) }); const j = await r.json(); return j.error ? { data: null, error: { message: j.error } } : { data: j.data, error: null }; },
  storage: { from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: '/qr/' + p } }), upload: async () => ({ error: { message: 'no uploads in the test harness' } }) }) } }) };`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json', '.png': 'image/png' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/stub-supabase.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(STUB); }
    if (req.method === 'POST' && (url.pathname.startsWith('/rpc/') || url.pathname === '/sql')) {
      let body = ''; for await (const c of req) body += c;
      const args = JSON.parse(body || '{}');
      try {
        let out;
        if (url.pathname === '/sql') out = (await db.query(args.sql, args.params || [])).rows;
        else {
          const fn = url.pathname.slice(5), keys = Object.keys(args);
          await db.exec('set role anon');
          try { out = (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]))).rows[0].r; } finally { await db.exec('reset role'); }
        }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: out ?? null }));
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    let p = url.pathname === '/' ? '/login.html' : url.pathname;
    const file = join(repo, decodeURIComponent(p));
    if (!file.startsWith(repo) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    let data = readFileSync(file);
    if (p === '/login.html') data = Buffer.from(data.toString('utf8').replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^>]*><\/script>/, '<script src="/stub-supabase.js"></script>'));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(port, '127.0.0.1', () => console.log('listening', port));
