CREATE TABLE public.island_dms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_key text NOT NULL,
  from_kind text NOT NULL CHECK (from_kind IN ('user','agent')),
  from_ref text NOT NULL,
  from_name text NOT NULL,
  to_kind text NOT NULL CHECK (to_kind IN ('user','agent')),
  to_ref text NOT NULL,
  body text NOT NULL CHECK (length(body) > 0 AND length(body) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX island_dms_thread_idx ON public.island_dms (thread_key, created_at);
CREATE INDEX island_dms_to_ref_idx ON public.island_dms (to_ref, created_at DESC);

GRANT SELECT, INSERT ON public.island_dms TO authenticated;
GRANT ALL ON public.island_dms TO service_role;

ALTER TABLE public.island_dms ENABLE ROW LEVEL SECURITY;

-- Participants can read their own threads
CREATE POLICY "Participants can read their DMs" ON public.island_dms
  FOR SELECT TO authenticated
  USING (
    (from_kind = 'user' AND from_ref = auth.uid()::text)
    OR (to_kind = 'user' AND to_ref = auth.uid()::text)
  );

-- Authenticated users can send as themselves
CREATE POLICY "Users can send DMs as themselves" ON public.island_dms
  FOR INSERT TO authenticated
  WITH CHECK (
    from_kind = 'user' AND from_ref = auth.uid()::text
  );

-- Realtime
ALTER TABLE public.island_dms REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.island_dms;