GRANT SELECT, INSERT, UPDATE ON public.world_settings TO anon, authenticated;
GRANT ALL ON public.world_settings TO service_role;
UPDATE public.world_settings SET value = jsonb_build_object('day', true), updated_at = now() WHERE key = 'time_mode';