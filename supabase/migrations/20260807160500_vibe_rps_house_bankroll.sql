-- The house needs a float, and it has to be a real balance row.
--
-- Two constraints on vibe_balances shape this and are easy to trip over:
--   * owner_kind is CHECKed to ('user','agent') — there is no 'system' wallet,
--     which is why the arcade's take is an effective burn recorded only in the
--     ledger rather than a pot anyone could spend.
--   * balance is CHECKed >= 0 — so the house cannot simply run negative when a
--     player wins. It must hold money before it can lose any.
--
-- Net exposure is one stake per hand: the table collects the ante at open and
-- pays at most 2x at settle. Dead-fair odds make the balance a random walk, so
-- the float only has to absorb variance, not expected loss. At a 25 stake,
-- 50,000 covers a swing far past anything this event will produce.
insert into public.vibe_balances (owner_kind, owner_ref, balance)
values ('agent', 'rps-house', 50000)
on conflict (owner_kind, owner_ref) do nothing;

insert into public.vibe_ledger (from_kind, from_ref, to_kind, to_ref, amount, reason, memo)
select 'system', 'treasury', 'agent', 'rps-house', 50000, 'starter',
       'opening float for the rock-paper-scissors table'
where not exists (
  select 1 from public.vibe_ledger
  where to_ref = 'rps-house' and reason = 'starter'
);
