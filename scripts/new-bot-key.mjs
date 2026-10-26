// Makes the secret key the trading bot uses to post its Exchange balance to the ledger (migration 20261031000001_bot_equity_sync.sql).
//   node scripts/new-bot-key.mjs
// Prints (1) the key: put it in the bot's mexc-keys.json as "ledgerBotKey", and (2) one SQL line: paste it in the Supabase SQL Editor.
// The database stores only the hash. Run it again for a new key (the old one stops working when the new SQL line is run).
import { randomBytes, createHash } from 'node:crypto';

const key = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(key).digest('hex');
console.log('1) Bot key (keep it secret; mexc-keys.json -> "ledgerBotKey"):\n\n   ' + key + '\n');
console.log('2) Paste this in the Supabase SQL Editor and Run:\n');
console.log(`   insert into public.ledger_settings(key, value) values ('bot_key_hash', '${hash}') on conflict (key) do update set value = excluded.value;\n`);
