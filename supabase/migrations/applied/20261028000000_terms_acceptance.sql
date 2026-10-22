-- Terms & risk acknowledgement. An investor must read and agree to the terms before they can see their balance.
-- The agreement is stored here (not just in the phone), with the version of the terms and the time, and can never be
-- edited or deleted. If the wording changes, the app's TERMS_VERSION changes and everyone is asked again on their next sign-in.
-- The manager sees who has agreed (and when) in the Users list.
-- Run after 20261027000000_profit_share_hardening.sql. Safe on live data: existing investors are asked on their next sign-in.

create table if not exists public.terms_acceptances (
  id          bigserial primary key,
  profile_id  uuid not null references public.profiles(id),
  version     text not null check (length(version) between 1 and 40),
  accepted_at timestamptz not null default now()
);
create index if not exists terms_acceptances_profile_idx on public.terms_acceptances(profile_id, id);
alter table public.terms_acceptances enable row level security;
revoke all on public.terms_acceptances from public, anon, authenticated;
revoke all on sequence public.terms_acceptances_id_seq from public, anon, authenticated;

drop trigger if exists terms_append_only on public.terms_acceptances;
create trigger terms_append_only before update or delete on public.terms_acceptances
  for each row execute function public._no_change();

-- "I agree": refused while the manager is only "viewing as" the person (they cannot agree on someone's behalf)
create or replace function public.accept_terms(p_token text, p_version text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v uuid := _me_rw(p_token); v_ver text := trim(coalesce(p_version, '')); v_at timestamptz;
begin
  if v_ver = '' or length(v_ver) > 40 then raise exception 'terms version missing'; end if;
  select accepted_at into v_at from terms_acceptances where profile_id = v and version = v_ver order by id desc limit 1;
  if v_at is null then
    insert into terms_acceptances(profile_id, version) values (v, v_ver) returning accepted_at into v_at;
  end if;
  return jsonb_build_object('version', v_ver, 'accepted_at', v_at);
end $$;

-- the person's own summary now says which version of the terms they last agreed to (null = never)
create or replace function public.my_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token); v_by uuid; r jsonb; t record;
begin
  select impersonated_by into v_by from sessions where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  r := _holder_summary(v) || jsonb_build_object('impersonated', v_by is not null);
  if r->>'role' <> 'admin' then r := r - 'share_pct'; end if;
  select version, accepted_at into t from terms_acceptances where profile_id = v order by id desc limit 1;
  return r || jsonb_build_object('terms_version', t.version, 'terms_accepted_at', t.accepted_at);
end $$;

-- the manager's list of people, with who has agreed and when
create or replace function public.admin_overview(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(_holder_summary(p.id) || jsonb_build_object('terms_version', t.version, 'terms_accepted_at', t.accepted_at)
                                    order by p.role, p.created_at)
                     from profiles p
                     left join lateral (select a.version, a.accepted_at from terms_acceptances a where a.profile_id = p.id order by a.id desc limit 1) t on true),
                  '[]'::jsonb);
end $$;

revoke all on function public.accept_terms(text, text) from public;
grant execute on function public.accept_terms(text, text) to anon, authenticated;
