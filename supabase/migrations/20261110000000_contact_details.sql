-- INVESTOR CONTACT DETAILS: phone (required), email (optional), an emergency contact (optional), so the manager can reach someone if anything happens.
-- Receiving details (GCash / bank / QR) already exist in payout_details (20261104000000); this is the other half. NOT applied to any database yet.
-- Run after 20261109000000_settlement_controls_backup.sql (it extends that file's backup export). Safe to run twice. No existing row is changed.
--
--   contact_details    one row per person: phone, email, emergency_name, emergency_phone. Closed to the website (RLS, no privileges).
--   contact_history    every value ever saved, who saved it and when. Append-only. A phone number changed right before a withdrawal is traceable.
--   set_my_contact     the person saves their own (a "view as" session cannot).        my_contact: the person reads their own.
--   admin_set_contact  the manager records it for a person (e.g. taken over the phone). admin_contacts: the manager sees everyone's, with who is missing.
--   setting contact_required_for_withdrawal ('off' by default): 'on' refuses a withdrawal request from an investor with no contact on file.
--                      Leave it off until everyone has added theirs (the manager sees who is missing in Users), then switch it on.
-- The activity log records THAT contact details changed and which fields, never the values (those live in contact_history, manager-only).

do $$
begin
  if to_regprocedure('public._export_extra()') is null or to_regprocedure('public._dump_table(text)') is null then
    raise exception 'preflight: run 20261109000000_settlement_controls_backup.sql first (the backup export this extends). Nothing was changed.';
  end if;
end $$;

insert into public.ledger_settings(key, value) values ('contact_required_for_withdrawal', 'off') on conflict (key) do nothing;

create table if not exists public.contact_details (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,
  phone           text not null,
  email           text,
  emergency_name  text,
  emergency_phone text,
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
create table if not exists public.contact_history (
  id              bigserial primary key,
  profile_id      uuid not null references public.profiles(id),
  phone           text,
  email           text,
  emergency_name  text,
  emergency_phone text,
  changed_by      uuid,
  changed_at      timestamptz not null default now()
);
create index if not exists contact_history_profile_idx on public.contact_history(profile_id, id);
alter table public.contact_details enable row level security;
alter table public.contact_history enable row level security;
revoke all on public.contact_details, public.contact_history from public, anon, authenticated;
revoke all on sequence public.contact_history_id_seq from public, anon, authenticated;
drop trigger if exists contact_history_append_only on public.contact_history;
create trigger contact_history_append_only before update or delete on public.contact_history for each row execute function public._no_change();

-- one place for the rules; returns the cleaned values or raises a plain message
create or replace function public._contact_clean(p_phone text, p_email text, p_en text, p_ep text, out o_phone text, out o_email text, out o_en text, out o_ep text)
language plpgsql immutable as $$
begin
  o_phone := regexp_replace(trim(coalesce(p_phone, '')), '\s+', ' ', 'g');
  if o_phone !~ '^\+?[0-9][0-9 ()-]{5,22}[0-9]$' or length(regexp_replace(o_phone, '[^0-9]', '', 'g')) not between 7 and 15 then
    raise exception 'enter a contact number with 7 to 15 digits, for example 0917 123 4567 or +63 917 123 4567';
  end if;
  o_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  if o_email is not null and (length(o_email) > 120 or o_email !~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$') then
    raise exception 'that email address does not look right';
  end if;
  o_en := nullif(trim(coalesce(p_en, '')), '');
  o_ep := nullif(regexp_replace(trim(coalesce(p_ep, '')), '\s+', ' ', 'g'), '');
  if o_ep is not null and (o_ep !~ '^\+?[0-9][0-9 ()-]{5,22}[0-9]$' or length(regexp_replace(o_ep, '[^0-9]', '', 'g')) not between 7 and 15) then
    raise exception 'the emergency contact number needs 7 to 15 digits';
  end if;
  if (o_en is null) <> (o_ep is null) then raise exception 'give both the emergency contact''s name and number, or leave both empty'; end if;
  if length(coalesce(o_en, '')) > 80 then raise exception 'the emergency contact name is too long'; end if;
end $$;

create or replace function public._contact_save(p_profile uuid, p_phone text, p_email text, p_en text, p_ep text, p_actor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c record; old contact_details%rowtype; v_fields text[] := '{}';
begin
  select * into c from _contact_clean(p_phone, p_email, p_en, p_ep);
  select * into old from contact_details where profile_id = p_profile;
  if found then
    if old.phone is distinct from c.o_phone then v_fields := array_append(v_fields, 'phone'::text); end if;
    if old.email is distinct from c.o_email then v_fields := array_append(v_fields, 'email'::text); end if;
    if old.emergency_name is distinct from c.o_en or old.emergency_phone is distinct from c.o_ep then v_fields := array_append(v_fields, 'emergency contact'::text); end if;
    if cardinality(v_fields) = 0 then return; end if;        -- nothing changed: no new history row
  else v_fields := array['phone', 'email', 'emergency contact']; end if;
  insert into contact_details(profile_id, phone, email, emergency_name, emergency_phone, updated_at, updated_by)
  values (p_profile, c.o_phone, c.o_email, c.o_en, c.o_ep, now(), p_actor)
  on conflict (profile_id) do update set phone = excluded.phone, email = excluded.email, emergency_name = excluded.emergency_name,
    emergency_phone = excluded.emergency_phone, updated_at = now(), updated_by = excluded.updated_by;
  insert into contact_history(profile_id, phone, email, emergency_name, emergency_phone, changed_by) values (p_profile, c.o_phone, c.o_email, c.o_en, c.o_ep, p_actor);
  perform _audit(p_actor, 'contact_updated', p_profile, jsonb_build_object('fields', to_jsonb(v_fields), 'by_manager', p_actor is distinct from p_profile));
end $$;

create or replace function public.my_contact(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token);
begin
  return (select to_jsonb(d) - 'updated_by' from contact_details d where d.profile_id = v);
end $$;

create or replace function public.set_my_contact(p_token text, p_phone text, p_email text default null, p_emergency_name text default null, p_emergency_phone text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token);
begin
  perform _contact_save(v, p_phone, p_email, p_emergency_name, p_emergency_phone, v);
end $$;

create or replace function public.admin_set_contact(p_token text, p_profile uuid, p_phone text, p_email text default null, p_emergency_name text default null, p_emergency_phone text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _admin(p_token);
begin
  if not exists (select 1 from profiles where id = p_profile) then raise exception 'unknown person'; end if;
  perform _contact_save(p_profile, p_phone, p_email, p_emergency_name, p_emergency_phone, v);
end $$;

-- everyone (manager only): their details, or null where nothing is on file, so the screen can show who is missing
create or replace function public.admin_contacts(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('profile_id', p.id, 'name', coalesce(nullif(p.name, ''), p.username), 'username', p.username, 'role', p.role, 'active', p.active,
            'phone', d.phone, 'email', d.email, 'emergency_name', d.emergency_name, 'emergency_phone', d.emergency_phone, 'updated_at', d.updated_at,
            'missing', d.profile_id is null) order by p.role, p.created_at, p.id)
          from profiles p left join contact_details d on d.profile_id = p.id), '[]'::jsonb);
end $$;

create or replace function public.admin_contact_history(p_token text, p_profile uuid) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('phone', h.phone, 'email', h.email, 'emergency_name', h.emergency_name, 'emergency_phone', h.emergency_phone,
            'changed_at', h.changed_at, 'changed_by', coalesce(nullif(a.name, ''), a.username)) order by h.id desc)
          from contact_history h left join profiles a on a.id = h.changed_by where h.profile_id = p_profile), '[]'::jsonb);
end $$;

-- optional rule: no withdrawal request without a contact on file (a trigger, so no existing function body is replaced)
create or replace function public._contact_gate() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(_setting('contact_required_for_withdrawal'), 'off') = 'on'
     and exists (select 1 from profiles where id = new.profile_id and role = 'investor')
     and not exists (select 1 from contact_details where profile_id = new.profile_id) then
    raise exception 'add your contact number (Home, under "How to reach me") before requesting a withdrawal, so we can confirm it with you';
  end if;
  return new;
end $$;
drop trigger if exists contact_gate on public.withdrawal_requests;
create trigger contact_gate before insert on public.withdrawal_requests for each row execute function public._contact_gate();

-- backups carry both tables (1109's coverage check would otherwise flag them as missing)
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payout_details', _dump_table('payout_details'),
    'idempotency_keys', _dump_table('idempotency_keys'),
    'holder_state', _dump_table('holder_state'),
    'investor_perf_draft_archive', _dump_table('investor_perf_draft_archive'),
    'perf_log_draft_archive', _dump_table('perf_log_draft_archive'),
    'settlement_exceptions', _dump_table('settlement_exceptions'),
    'contact_details', _dump_table('contact_details'),
    'contact_history', _dump_table('contact_history'))
$$;

-- _export_all() returns the whole ledger export, contact details included. It must never be callable from the website: revoke it again here
-- (idempotent), so these numbers and emails are protected even if 1109 or the hotfix has not been applied yet.
revoke all on function public._contact_clean(text, text, text, text), public._contact_save(uuid, text, text, text, text, uuid), public._contact_gate(), public._export_extra(),
  public._export_all(), public._export_all_core() from public, anon, authenticated;
revoke all on function public.my_contact(text), public.set_my_contact(text, text, text, text, text), public.admin_set_contact(text, uuid, text, text, text, text),
  public.admin_contacts(text), public.admin_contact_history(text, uuid) from public;
grant execute on function public.my_contact(text), public.set_my_contact(text, text, text, text, text), public.admin_set_contact(text, uuid, text, text, text, text),
  public.admin_contacts(text), public.admin_contact_history(text, uuid) to anon, authenticated;
