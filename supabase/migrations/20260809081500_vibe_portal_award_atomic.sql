-- One award, one statement.
--
-- The first cut of this lived in the edge function as read-budgets, decide,
-- write-balance, write-session. Two tabs of the same game racing that read
-- the same `awarded` and both spent against it, which is exactly the hole the
-- budgets exist to close. Eight simultaneous requests for 12 against a
-- 60-coin session budget paid 96. Here the session row is taken `for update`
-- before anything is summed, so the second caller waits and then sees the
-- first caller's spend — the same eight requests pay 60.
--
-- What this still does not serialise: two DIFFERENT players hitting the same
-- game's daily budget at the same instant lock different rows, so the game's
-- daily total can overshoot by at most one `max_award` per concurrent caller.
-- Locking the game row instead would fix it and would also make every award
-- in a popular game queue behind every other. Overshooting a play-money
-- budget by twelve coins is the cheaper problem.
create or replace function public.vibe_portal_award(
  p_session uuid,
  p_amount  integer,
  p_reason  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s          record;
  g          record;
  v_today    date := (now() at time zone 'utc')::date;
  spent_all  integer;
  spent_mine integer;
  running    integer;
  amount     integer;
  bal        numeric;
  had_wallet boolean;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be > 0';
  end if;

  select * into s from vibe_portal_sessions where id = p_session for update;
  if not found                       then raise exception 'no such session'; end if;
  if s.closed_at is not null          then raise exception 'that session is closed'; end if;
  if s.day <> v_today                 then raise exception 'that session is from another day'; end if;
  -- A visit goes stale: long enough for a real session, short enough that a
  -- session id left in a closed tab is not a standing line of credit.
  if now() - s.opened_at > interval '180 minutes'
                                      then raise exception 'that session has gone cold'; end if;
  -- A bound on the NUMBER of awards, not their size. A game paying a coin per
  -- frame is a bug in the game, and it would otherwise cost a thousand round
  -- trips before any budget noticed.
  if s.awards >= 120                  then raise exception 'that session has asked for enough'; end if;

  select * into g from vibe_portal_games where slug = s.slug;
  if not found or not g.active        then raise exception 'that game is not open'; end if;

  select coalesce(sum(awarded), 0),
         coalesce(sum(awarded) filter (where owner_ref = s.owner_ref), 0)
    into spent_all, spent_mine
    from vibe_portal_sessions
   where slug = s.slug and day = v_today;

  -- What is left to earn here, ignoring the per-award cap: this is the number
  -- worth telling a player, because it is the one that runs out.
  running := greatest(0, least(
    g.session_budget - s.awarded,
    g.player_daily   - spent_mine,
    g.daily_budget   - spent_all));

  amount := least(p_amount, g.max_award, running);

  select balance into bal from vibe_balances
   where owner_kind = s.owner_kind and owner_ref = s.owner_ref;
  had_wallet := found;
  if not had_wallet then bal := 0; end if;

  if amount <= 0 then
    return jsonb_build_object('amount', 0, 'balance', bal, 'capped', true,
                              'headroom', running, 'asked', p_amount);
  end if;

  if had_wallet then
    update vibe_balances set balance = balance + amount, updated_at = now()
     where owner_kind = s.owner_kind and owner_ref = s.owner_ref;
  else
    -- Somebody can arrive through a portal game before they have ever opened
    -- the vibeverse itself. No starter grant here on purpose: the coins being
    -- earned are the point, and `vibe-economy wallet` hands out the welcome
    -- 100 the first time they look at a balance.
    insert into vibe_balances(owner_kind, owner_ref, balance)
      values (s.owner_kind, s.owner_ref, amount);
  end if;

  insert into vibe_ledger(from_kind, from_ref, to_kind, to_ref, amount, reason, memo)
    values ('system', 'portal', s.owner_kind, s.owner_ref, amount, 'portal_award',
            case when coalesce(btrim(p_reason), '') = ''
                 then g.title else g.title || ' · ' || btrim(p_reason) end);

  update vibe_portal_sessions
     set awarded = awarded + amount, awards = awards + 1, last_award_at = now()
   where id = p_session;

  return jsonb_build_object('amount', amount, 'balance', bal + amount,
                            'capped', amount < p_amount,
                            'headroom', running - amount, 'asked', p_amount);
end $$;

-- security definer means this bypasses RLS, so it must not be reachable from
-- the browser: only the edge function's service role may call it.
revoke all on function public.vibe_portal_award(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.vibe_portal_award(uuid, integer, text) to service_role;

comment on function public.vibe_portal_award(uuid, integer, text) is
  'Pays min(asked, max_award, remaining budgets) into a portal player''s wallet, atomically. Called only by the vibe-portal edge function.';
