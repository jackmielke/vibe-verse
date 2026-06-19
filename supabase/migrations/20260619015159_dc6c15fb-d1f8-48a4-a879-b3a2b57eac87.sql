CREATE TABLE public.island_spawns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cube','sphere','torus','cone','pyramid','tetra')),
  color TEXT NOT NULL DEFAULT '#2dd4a8',
  label TEXT,
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,
  pos_z REAL NOT NULL DEFAULT 0,
  rot_y REAL NOT NULL DEFAULT 0,
  scale REAL NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.island_spawns TO anon;
GRANT SELECT, INSERT, DELETE ON public.island_spawns TO authenticated;
GRANT ALL ON public.island_spawns TO service_role;

ALTER TABLE public.island_spawns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view island spawns"
  ON public.island_spawns FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can create their own spawns"
  ON public.island_spawns FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Creators can delete their own spawns"
  ON public.island_spawns FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX island_spawns_created_at_idx ON public.island_spawns (created_at DESC);

ALTER TABLE public.island_spawns REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.island_spawns;