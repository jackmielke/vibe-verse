-- Recording a score is a read-modify-write, and two runs finishing at once
-- (two tabs, or a retried request) would both read the old best and the loser
-- would overwrite the winner. One statement under the row lock instead: the
-- best only ever goes up, and every play is counted.
create or replace function public.vibe_round_record_score(
  p_round_id uuid,
  p_owner_ref text,
  p_score integer
) returns table (best_score integer, plays integer)
language sql
security definer
set search_path = public
as $$
  update public.vibe_round_entries e
     set best_score = greatest(e.best_score, p_score),
         plays      = e.plays + 1,
         updated_at = now()
   where e.round_id = p_round_id
     and e.owner_ref = p_owner_ref
  returning e.best_score, e.plays;
$$;

revoke all on function public.vibe_round_record_score(uuid, text, integer) from public, anon, authenticated;
