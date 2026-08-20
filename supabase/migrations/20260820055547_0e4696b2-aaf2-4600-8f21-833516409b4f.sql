CREATE TABLE public.empyrean_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT empyrean_notes_author_len CHECK (char_length(author) BETWEEN 1 AND 32),
  CONSTRAINT empyrean_notes_body_len CHECK (char_length(body) BETWEEN 1 AND 180)
);

GRANT SELECT, INSERT ON public.empyrean_notes TO anon;
GRANT SELECT, INSERT ON public.empyrean_notes TO authenticated;
GRANT ALL ON public.empyrean_notes TO service_role;

ALTER TABLE public.empyrean_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read notes" ON public.empyrean_notes FOR SELECT USING (true);
CREATE POLICY "Anyone can leave a note" ON public.empyrean_notes FOR INSERT WITH CHECK (true);

CREATE INDEX empyrean_notes_created_idx ON public.empyrean_notes (created_at DESC);