
CREATE TABLE public.edm_guestbook (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.edm_guestbook TO anon, authenticated;
GRANT ALL ON public.edm_guestbook TO service_role;
ALTER TABLE public.edm_guestbook ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read guestbook" ON public.edm_guestbook FOR SELECT USING (true);
CREATE POLICY "Anyone can sign guestbook" ON public.edm_guestbook FOR INSERT WITH CHECK (true);
CREATE INDEX edm_guestbook_recent_idx ON public.edm_guestbook (created_at DESC);
