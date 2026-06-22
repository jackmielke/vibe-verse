GRANT SELECT, INSERT ON public.island_dms TO anon;

DROP POLICY IF EXISTS "Anyone can read island DMs" ON public.island_dms;
CREATE POLICY "Anyone can read island DMs" ON public.island_dms
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Guests can send DMs" ON public.island_dms;
CREATE POLICY "Guests can send DMs" ON public.island_dms
  FOR INSERT TO anon
  WITH CHECK (from_kind = 'user');
