-- BOT EQUITY SYNC: lets the trading bot post the real Exchange futures balance as an equity reading, so the ledger's unit price
-- follows the account without anyone typing the number.
--
-- What the bot can do: ONE thing, record an equity reading ('update', exactly what the manager's "Update equity" button does).
-- What it cannot do: deposit, withdraw, close a quarter, create or see any user, or read anything. It has no login. It holds a
-- secret key; the database keeps only the SHA-256 hash of it (ledger_settings 'bot_key_hash'), set by scripts/new-bot-key.mjs.
--
-- The reading is SKIPPED (nothing written, the bot is told why) when it could misprice the pool:
--   * paused         the manager turned sync off (ledger_settings bot_sync_paused = '1')
--   * no units yet   nobody has deposited
--   * deposit waiting  money recorded as received but not yet turned into units: the manager's own "Update equity" does that,
--                    after checking the money is really in the exchange (a bot reading would subtract money that may not have arrived)
--   * withdrawal pending  a withdrawal request is open: the payout leaves the exchange before it is recorded, which would look like a loss
--   * too soon       the last reading is less than bot_min_minutes (10) old
--   * jump           the balance moved more than bot_max_jump (15%) since the last reading: far more than 1%-risk trading can do
--                    in 4 hours, so it is probably a transfer in or out, which the manager must record first
-- Wrong key: the call fails with 'not allowed'.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run, then run scripts/new-bot-key.mjs and paste the one SQL line it prints.
-- To pause the sync (e.g. before paying someone out):  update public.ledger_settings set value = '1' where key = 'bot_sync_paused';

insert into public.ledger_settings(key, value) values
  ('bot_sync_paused', '0'),
  ('bot_max_jump', '0.15'),
  ('bot_min_minutes', '10')
on conflict (key) do nothing;

create or replace function public.bot_post_equity(p_key text, p_equity numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := _setting('bot_key_hash'); u numeric := _total_units();
  v_last pool_equity%rowtype; v_price numeric; v_at timestamptz; v_jump numeric := coalesce(_setting('bot_max_jump'), '0.15')::numeric;
begin
  if v_hash is null or v_hash = '' or encode(digest(coalesce(p_key, ''), 'sha256'), 'hex') <> v_hash then
    raise exception 'not allowed';
  end if;
  if p_equity is null or p_equity <= 0 then raise exception 'equity must be more than 0'; end if;
  if coalesce(_setting('bot_sync_paused'), '0') = '1' then return jsonb_build_object('ok', false, 'skipped', 'paused'); end if;
  if u = 0 then return jsonb_build_object('ok', false, 'skipped', 'no units yet: record the first deposit first'); end if;
  if _pending_total() > 0 then
    return jsonb_build_object('ok', false, 'skipped', 'a deposit is waiting to join: post the next reading by hand (Update equity)');
  end if;
  if exists (select 1 from withdrawal_requests where status = 'pending') then
    return jsonb_build_object('ok', false, 'skipped', 'a withdrawal request is open: the payout may already have left Exchange');
  end if;
  select * into v_last from pool_equity order by ts desc, id desc limit 1;
  if v_last.id is not null then
    if v_last.ts > now() - make_interval(mins => coalesce(_setting('bot_min_minutes'), '10')::int) then
      return jsonb_build_object('ok', false, 'skipped', 'too soon after the last reading');
    end if;
    if v_last.equity_usdt > 0 and abs(p_equity / v_last.equity_usdt - 1) > v_jump then
      return jsonb_build_object('ok', false, 'skipped', 'jump', 'last_usdt', v_last.equity_usdt, 'new_usdt', p_equity,
                                'detail', 'balance moved more than ' || round(v_jump * 100) || '% since the last reading: record the transfer, then post by hand');
    end if;
  end if;
  v_at := _at(null);
  v_price := _price_from(p_equity);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'update', p_equity, u, v_price, _last_php_rate(), coalesce(p_note, 'Exchange balance (bot)'), null);
  return jsonb_build_object('ok', true, 'unit_price', v_price, 'equity_usdt', p_equity, 'total_units', u);
end $$;

revoke all on function public.bot_post_equity(text, numeric, text) from public;
grant execute on function public.bot_post_equity(text, numeric, text) to anon, authenticated;
