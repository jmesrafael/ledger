// Makes the secret ONE wallet's bot uses to report to the ledger (migration 20261130000000_wallet_snapshots.sql). One key per wallet: a key only works for its own wallet.
//   node scripts/new-wallet-key.mjs bbcore "BB-Core"
//   node scripts/new-wallet-key.mjs icore  "I-Core"
// Prints (1) the key: put it in that bot's mexc-keys.json as "ledgerWalletKey" (and the wallet name as "ledgerWallet"), and (2) one SQL statement: paste it in the Supabase
// SQL Editor. The database stores only the hash, never the key. Run it again for the same wallet to ROTATE the key: the old key stops working when the new SQL runs.
import { randomBytes, createHash } from 'node:crypto';

const [wallet, label] = process.argv.slice(2);
if (!wallet || !/^[a-z][a-z0-9_]{1,19}$/.test(wallet)) {
  console.error('usage: node scripts/new-wallet-key.mjs <wallet> "<label>"   (wallet: lowercase letters, digits, underscore; 2 to 20 characters, for example bbcore or icore)');
  process.exit(1);
}
const name = (label || wallet).replace(/'/g, "''");
const key = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(key).digest('hex');
console.log(`1) Wallet key for "${wallet}" (keep it secret; that bot's mexc-keys.json -> "ledgerWallet": "${wallet}", "ledgerWalletKey": "<this key>"):\n\n   ${key}\n`);
console.log('2) Paste this in the Supabase SQL Editor and Run (creates the wallet, or rotates its key):\n');
console.log(`   insert into public.bot_wallets(wallet, label, key_hash) values ('${wallet}', '${name}', '${hash}')\n   on conflict (wallet) do update set key_hash = excluded.key_hash, label = excluded.label, active = true;\n`);
console.log('The ledger refuses wallet snapshots until BOTH wallets are registered and reporting (wallet_expected_count = 2), so one bot alone can never value the pool.');
