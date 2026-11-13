// Builds supabase/migrations/20261214000000_auto_settlement.sql and its rollback from the parts in supabase/parts/auto-settlement/ and the functions as they
// are in the applied migrations, so the settlement core is the applied admin_close_quarter_tv body, character for character, with only the actor's source changed.
//   node scripts/build-auto-settlement.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../supabase/', import.meta.url), A = new URL('migrations/applied/', root), P = new URL('parts/auto-settlement/', root);
const read = (u) => readFileSync(u, 'utf8');   // bytes as they are: the rollback must put back exactly what the applied files created
const tv = read(new URL('20261207000000_true_value_pricing.sql', A)), nav = read(new URL('20261213000000_live_nav.sql', A));
const grab = (src, name) => {
  const i = src.indexOf('create or replace function public.' + name + '('), j = src.indexOf('\nend $$;', i);
  if (i < 0 || j < 0) throw new Error('function not found: ' + name);
  return src.slice(i, j + 8);
};
const orig = grab(tv, 'admin_close_quarter_tv'), wrapOrig = grab(nav, 'bot_post_wallet_snapshot');
const core = orig
  .replace('create or replace function public.admin_close_quarter_tv(p_token text, p_php_rate numeric default null, p_note text default null, p_idem text default null) returns jsonb',
    'create or replace function public._close_quarter_tv_core(p_actor uuid, p_php_rate numeric default null, p_note text default null, p_idem text default null) returns jsonb')
  .replace('v_actor uuid := _admin(p_token);', 'v_actor uuid := p_actor;');
if (core === orig || !core.includes('_close_quarter_tv_core(p_actor uuid') || !core.includes('v_actor uuid := p_actor;') || core.includes('p_token')) throw new Error('the core could not be derived');
writeFileSync(new URL('migrations/20261214000000_auto_settlement.sql', root), read(new URL('head.sql', P)) + '\n' + core + '\n' + read(new URL('tail.sql', P)));
writeFileSync(new URL('rollback/20261214000000_rollback_auto_settlement.sql', root),
  read(new URL('rollback-head.sql', P)) + '\n' + orig + '\n\n' + wrapOrig + '\n\n' + read(new URL('rollback-tail.sql', P)));
console.log('built: migrations/20261214000000_auto_settlement.sql and rollback/20261214000000_rollback_auto_settlement.sql');
