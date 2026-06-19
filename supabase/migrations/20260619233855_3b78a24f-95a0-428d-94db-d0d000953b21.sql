
ALTER TABLE public.island_spawns
  ADD COLUMN IF NOT EXISTS model_url TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
