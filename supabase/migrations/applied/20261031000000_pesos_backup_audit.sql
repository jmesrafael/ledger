-- Three things in one file. Run after 20261030000000_net_of_fee_returns.sql. Safe on live data: it adds tables and functions, and
-- changes no existing money entry.
--
-- 1. my_ledger now also returns the pesos actually paid (php_amount) and the rate used (php_rate) on each of a person's OWN
--    entries, so the app can show "Put in" as the pesos they really handed over instead of dollars converted at today's rate.
-- 2. Activity log (audit_log): who changed what and when. Filled by database triggers, so it cannot be skipped by any code path
--    and nobody (not even the manager, from the website) can edit or delete a row. _me() now records which signed-in person is
--    acting. Only the manager can read the log (admin_audit_log).
--    Logged: accounts created / renamed / (de)activated / profit-share rate changed or scheduled / password changed or reset,
--    money received / handed back / joined the pool / paid out, profit share charged, equity readings, quarter closes,
--    corrections (undo), withdrawal requests (made / cancelled / paid), terms agreed, "view as", setting changes, backups.
--    Not logged: sign-ins, and who merely looked at a page.
-- 3. Backups: admin_export_all (the manager downloads everything now) and backup_export (a nightly job uses a revocable
--    backup key that can ONLY read the export, so the manager's password never sits on a server). Exports never contain
--    password hashes or sessions.

-- ---------------------------------------------------------------- 1. pesos paid on a person's own entries
create or replace function public.my_ledger(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ts', ts, 'profile_id', profile_id, 'kind', kind, 'units', units,
           'usdt', usdt, 'unit_price', unit_price, 'php_rate', php_rate, 'php_amount', php_amount, 'lock_until', lock_until, 'note', note) order by id desc)
         from ledger where profile_id = v), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- 2. who is acting (recorded for the audit triggers)
create or replace function public._me(p_token text) returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare v uuid;
begin
  select s.profile_id into v from sessions s join profiles p on p.id = s.profile_id
   where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires_at > now() and p.active;
  if v is null then raise exception 'not signed in'; end if;
  perform set_config('ledger.actor', v::text, true);   -- this transaction only
  return v;
end $$;

create table if not exists public.audit_log (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  actor_id     uuid,
  actor_name   text,
  actor_role   text,
  action       text not null,
  subject_id   uuid,
  subject_name text,
  detail       jsonb not null default '{}'::jsonb
);   -- no foreign keys on purpose: names are copied in, so the log reads the same even if an account changes later
alter table public.audit_log enable row level security;
revoke all on public.audit_log from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;

create or replace function public._audit_actor() returns uuid language sql stable as $$ select nullif(current_setting('ledger.actor', true), '')::uuid $$;

create or replace function public._audit(p_actor uuid, p_action text, p_subject uuid, p_detail jsonb default '{}'::jsonb) returns void
language sql volatile security definer set search_path = public as $$
  insert into audit_log(actor_id, actor_name, actor_role, action, subject_id, subject_name, detail)
  select a.id, coalesce(nullif(a.name, ''), a.username), a.role, p_action, s.id, coalesce(nullif(s.name, ''), s.username), coalesce(p_detail, '{}'::jsonb)
    from (select 1) x left join profiles a on a.id = p_actor left join profiles s on s.id = p_subject
$$;

create or replace function public._audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'the activity log cannot be changed or deleted'; end $$;
drop trigger if exists audit_log_immutable on public.audit_log;
create trigger audit_log_immutable before update or delete on public.audit_log for each row execute function public._audit_immutable();

-- accounts
create or replace function public._audit_profiles() returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid := _audit_actor();
begin
  if tg_op = 'INSERT' then
    perform _audit(a, 'user_created', new.id, jsonb_build_object('username', new.username, 'role', new.role, 'fee_rate', new.fee_rate));
    return new;
  end if;
  if new.fee_rate is distinct from old.fee_rate then perform _audit(a, 'rate_changed', new.id, jsonb_build_object('from', old.fee_rate, 'to', new.fee_rate)); end if;
  if new.fee_rate_next is distinct from old.fee_rate_next and new.fee_rate_next is not null then perform _audit(a, 'rate_scheduled', new.id, jsonb_build_object('to', new.fee_rate_next)); end if;
  if new.active is distinct from old.active then perform _audit(a, case when new.active then 'reactivated' else 'deactivated' end, new.id); end if;
  if new.name is distinct from old.name then perform _audit(a, 'name_changed', new.id, jsonb_build_object('from', old.name, 'to', new.name)); end if;
  if new.pass_hash is distinct from old.pass_hash then perform _audit(a, case when a = new.id then 'password_changed' else 'password_reset' end, new.id); end if;
  return new;
end $$;
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles after insert or update on public.profiles for each row execute function public._audit_profiles();

-- equity readings and quarter closes (deposits / withdrawals are logged from the ledger rows, which know the person)
create or replace function public._audit_pool_equity() returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid := coalesce(new.created_by, _audit_actor());
begin
  if new.kind in ('update', 'close') then
    perform _audit(a, case when new.reversed_of is not null then 'correction' when new.kind = 'close' then 'quarter_closed' else 'equity_reading' end, null,
      jsonb_build_object('kind', new.kind, 'equity_usdt', new.equity_usdt, 'unit_price', new.unit_price, 'note', new.note, 'at', new.ts));
  end if;
  return new;
end $$;
drop trigger if exists audit_pool_equity on public.pool_equity;
create trigger audit_pool_equity after insert on public.pool_equity for each row execute function public._audit_pool_equity();

-- money in / out and profit share
create or replace function public._audit_ledger() returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid := coalesce((select created_by from pool_equity where id = new.equity_id), _audit_actor());
begin
  if new.kind in ('deposit', 'withdrawal') then
    perform _audit(a, case when new.reversed_of is not null then 'correction' when new.kind = 'deposit' then 'money_in' else 'money_out' end, new.profile_id,
      jsonb_build_object('kind', new.kind, 'usdt', new.usdt, 'units', new.units, 'unit_price', new.unit_price, 'php_amount', new.php_amount, 'note', new.note, 'at', new.ts));
  elsif new.kind = 'fee_out' then
    perform _audit(a, 'fee_charged', new.profile_id, jsonb_build_object('usdt', new.usdt, 'units', new.units, 'unit_price', new.unit_price, 'note', new.note, 'at', new.ts));
  end if;
  return new;
end $$;
drop trigger if exists audit_ledger on public.ledger;
create trigger audit_ledger after insert on public.ledger for each row execute function public._audit_ledger();

-- money waiting to join
create or replace function public._audit_pending() returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid := coalesce(new.created_by, _audit_actor());
begin
  if tg_op = 'INSERT' then
    perform _audit(a, 'money_received', new.profile_id, jsonb_build_object('usdt', new.usdt, 'php_amount', new.php_amount, 'note', new.note, 'at', new.received_at));
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    perform _audit(_audit_actor(), 'money_handed_back', new.profile_id, jsonb_build_object('usdt', new.usdt, 'php_amount', new.php_amount));
  end if;
  return new;
end $$;
drop trigger if exists audit_pending on public.pending_deposits;
create trigger audit_pending after insert or update on public.pending_deposits for each row execute function public._audit_pending();

-- withdrawal requests
create or replace function public._audit_requests() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform _audit(new.profile_id, 'withdrawal_requested', new.profile_id, jsonb_build_object('units', new.units, 'pay_by', new.pay_by));
  elsif new.status is distinct from old.status and new.status in ('cancelled', 'paid') then
    perform _audit(_audit_actor(), case when new.status = 'paid' then 'withdrawal_paid' else 'withdrawal_cancelled' end, new.profile_id, jsonb_build_object('units', new.units));
  end if;
  return new;
end $$;
drop trigger if exists audit_requests on public.withdrawal_requests;
create trigger audit_requests after insert or update on public.withdrawal_requests for each row execute function public._audit_requests();

-- terms agreed, "view as" sessions, setting changes
create or replace function public._audit_terms() returns trigger language plpgsql security definer set search_path = public as $$
begin perform _audit(new.profile_id, 'terms_agreed', new.profile_id, jsonb_build_object('version', new.version)); return new; end $$;
drop trigger if exists audit_terms on public.terms_acceptances;
create trigger audit_terms after insert on public.terms_acceptances for each row execute function public._audit_terms();

create or replace function public._audit_sessions() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.impersonated_by is not null then perform _audit(new.impersonated_by, 'viewed_as', new.profile_id); end if;
  return new;
end $$;
drop trigger if exists audit_sessions on public.sessions;
create trigger audit_sessions after insert on public.sessions for each row execute function public._audit_sessions();

create or replace function public._audit_settings() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.value is distinct from old.value then perform _audit(_audit_actor(), 'setting_changed', null, jsonb_build_object('key', new.key, 'from', old.value, 'to', new.value)); end if;
  return new;
end $$;
drop trigger if exists audit_settings on public.ledger_settings;
create trigger audit_settings after update on public.ledger_settings for each row execute function public._audit_settings();

-- the manager reads the log (newest first; pass p_before = the smallest id seen to load older rows)
create or replace function public.admin_audit_log(p_token text, p_limit int default 200, p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc)
                     from (select id, ts, actor_id, actor_name, actor_role, action, subject_id, subject_name, detail
                             from audit_log where p_before is null or id < p_before order by id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- 3. backups
create table if not exists public.backup_keys (
  id           bigserial primary key,
  label        text not null default 'nightly backup',
  key_hash     text not null unique,        -- sha256 of the key; the key itself is never stored
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.backup_keys enable row level security;
revoke all on public.backup_keys from public, anon, authenticated;
revoke all on sequence public.backup_keys_id_seq from public, anon, authenticated;

create or replace function public._export_all() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'format', 'lucidyo-ledger-backup-1',
    'exported_at', now(),
    'people', (select coalesce(jsonb_agg(to_jsonb(p) - 'pass_hash' - 'failed_attempts' - 'locked_until' order by p.created_at, p.id), '[]'::jsonb) from profiles p),
    'pool_equity', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb) from pool_equity e),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) from ledger l),
    'pending_deposits', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) from pending_deposits d),
    'withdrawal_requests', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) from withdrawal_requests r),
    'holder_lots', (select coalesce(jsonb_agg(to_jsonb(h) order by h.id), '[]'::jsonb) from holder_lots h),
    'lot_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from lot_log g),
    'terms_acceptances', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from terms_acceptances t),
    'settings', (select coalesce(jsonb_agg(to_jsonb(s) order by s.key), '[]'::jsonb) from ledger_settings s),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from audit_log a),
    -- numbers the reader can re-check against the data above before trusting a backup
    'checks', jsonb_build_object(
      'people', (select count(*) from profiles), 'ledger_rows', (select count(*) from ledger), 'equity_rows', (select count(*) from pool_equity),
      'total_units_ledger', (select coalesce(sum(units), 0) from ledger),
      'total_units_last_reading', (select total_units from pool_equity order by id desc limit 1),
      'lots_units', (select coalesce(sum(units), 0) from holder_lots),
      'last_equity_usdt', (select equity_usdt from pool_equity order by id desc limit 1),
      'waiting_usdt', (select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending')))
$$;

create or replace function public.admin_export_all(p_token text) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare a uuid := _admin(p_token); r jsonb := _export_all();
begin
  perform _audit(a, 'backup_exported', null, jsonb_build_object('how', 'download by the manager', 'ledger_rows', (r->'checks'->>'ledger_rows')::int));
  return r;
end $$;

create or replace function public.backup_export(p_key text) returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare k backup_keys%rowtype; r jsonb;
begin
  select * into k from backup_keys where key_hash = encode(digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if not found then raise exception 'invalid backup key'; end if;
  update backup_keys set last_used_at = now() where id = k.id;
  r := _export_all();
  perform _audit(null, 'backup_exported', null, jsonb_build_object('how', 'automatic, key "' || k.label || '"', 'ledger_rows', (r->'checks'->>'ledger_rows')::int));
  return r;
end $$;

-- the key is shown once, at creation; only its hash is stored
create or replace function public.admin_create_backup_key(p_token text, p_label text default 'nightly backup') returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare a uuid := _admin(p_token); v text := encode(gen_random_bytes(24), 'hex');
begin
  insert into backup_keys(label, key_hash) values (left(coalesce(nullif(trim(p_label), ''), 'nightly backup'), 60), encode(digest(v, 'sha256'), 'hex'));
  perform _audit(a, 'backup_key_created', null, jsonb_build_object('label', left(coalesce(nullif(trim(p_label), ''), 'nightly backup'), 60)));
  return v;
end $$;

create or replace function public.admin_revoke_backup_keys(p_token text) returns int language plpgsql volatile security definer set search_path = public as $$
declare a uuid := _admin(p_token); n int;
begin
  delete from backup_keys; get diagnostics n = row_count;
  perform _audit(a, 'backup_keys_revoked', null, jsonb_build_object('count', n));
  return n;
end $$;

create or replace function public.admin_backup_status(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return jsonb_build_object(
    'keys', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'created_at', created_at, 'last_used_at', last_used_at) order by id), '[]'::jsonb) from backup_keys),
    'last_export', (select jsonb_build_object('ts', ts, 'detail', detail) from audit_log where action = 'backup_exported' order by id desc limit 1),
    'last_automatic', (select ts from audit_log where action = 'backup_exported' and detail->>'how' like 'automatic%' order by id desc limit 1));
end $$;

-- ---------------------------------------------------------------- access
revoke all on function public._audit_actor(), public._audit(uuid, text, uuid, jsonb), public._audit_immutable(), public._audit_profiles(),
  public._audit_pool_equity(), public._audit_ledger(), public._audit_pending(), public._audit_requests(), public._audit_terms(),
  public._audit_sessions(), public._audit_settings(), public._export_all() from public, anon, authenticated;
revoke all on function public.admin_audit_log(text, int, bigint), public.admin_export_all(text), public.backup_export(text),
  public.admin_create_backup_key(text, text), public.admin_revoke_backup_keys(text), public.admin_backup_status(text) from public;
grant execute on function public.admin_audit_log(text, int, bigint), public.admin_export_all(text), public.backup_export(text),
  public.admin_create_backup_key(text, text), public.admin_revoke_backup_keys(text), public.admin_backup_status(text) to anon, authenticated;
