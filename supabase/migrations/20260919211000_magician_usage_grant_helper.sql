-- Top up a device by hand ("give this phone another twenty minutes"):
--   select public.vibe_magician_grant('the-device-id', 1200);
-- The device id is under localStorage["magician.device"] on that phone, and
-- the status reply of vibe-magician-voice reports what it has left.
create or replace function public.vibe_magician_grant(device text, seconds integer)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.vibe_magician_usage (device_id, seconds_granted)
  values (device, seconds)
  on conflict (device_id) do update set seconds_granted = vibe_magician_usage.seconds_granted + excluded.seconds_granted, updated_at = now()
  returning 600 + seconds_granted - seconds_used;
$$;
revoke all on function public.vibe_magician_grant(text, integer) from public, anon, authenticated;
grant execute on function public.vibe_magician_grant(text, integer) to service_role;

-- A probe row for verifying the out-of-minutes path from a script.
insert into public.vibe_magician_usage (device_id, seconds_used)
values ('test-device-limit', 600)
on conflict (device_id) do update set seconds_used = 600, session_started_at = null;
