CREATE TABLE public.world_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.world_settings TO anon;
GRANT SELECT, INSERT, UPDATE ON public.world_settings TO authenticated, anon;
GRANT ALL ON public.world_settings TO service_role;

ALTER TABLE public.world_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "World settings are readable by everyone"
  ON public.world_settings FOR SELECT
  USING (true);

CREATE POLICY "Anyone can toggle world settings"
  ON public.world_settings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update world settings"
  ON public.world_settings FOR UPDATE
  USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.world_settings;

INSERT INTO public.world_settings (key, value) VALUES ('time_mode', '{"day": false}'::jsonb)
  ON CONFLICT (key) DO NOTHING;