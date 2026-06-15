-- 1. Worlds table
CREATE TABLE public.worlds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  blurb           text,
  creator_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  github_url      text,
  route           text NOT NULL,
  preview_url     text,
  hero_model_url  text,
  tags            text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  is_featured     boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 100,
  play_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 2. Grants (anon can browse approved worlds; auth can submit/edit own)
GRANT SELECT ON public.worlds TO anon;
GRANT SELECT, INSERT, UPDATE ON public.worlds TO authenticated;
GRANT ALL ON public.worlds TO service_role;

-- 3. RLS
ALTER TABLE public.worlds ENABLE ROW LEVEL SECURITY;

-- Anyone can read approved worlds
CREATE POLICY "Anyone can view approved worlds"
  ON public.worlds FOR SELECT
  USING (status = 'approved');

-- Creators can view their own submissions (any status)
CREATE POLICY "Creators view own worlds"
  ON public.worlds FOR SELECT
  TO authenticated
  USING (creator_id = public.get_user_id_from_auth(auth.uid()));

-- Admins can view all worlds
CREATE POLICY "Admins view all worlds"
  ON public.worlds FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Signed-in users can submit worlds (must be themselves, must be pending)
CREATE POLICY "Authenticated users submit worlds"
  ON public.worlds FOR INSERT
  TO authenticated
  WITH CHECK (
    creator_id = public.get_user_id_from_auth(auth.uid())
    AND status = 'pending'
  );

-- Creators can edit their own submissions
CREATE POLICY "Creators edit own worlds"
  ON public.worlds FOR UPDATE
  TO authenticated
  USING (creator_id = public.get_user_id_from_auth(auth.uid()))
  WITH CHECK (creator_id = public.get_user_id_from_auth(auth.uid()));

-- Admins can edit everything (approve/reject)
CREATE POLICY "Admins manage all worlds"
  ON public.worlds FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 4. updated_at trigger (reuse existing function)
CREATE TRIGGER worlds_updated_at
  BEFORE UPDATE ON public.worlds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Helper: bump play_count without granting blanket update
CREATE OR REPLACE FUNCTION public.bump_world_play_count(_world_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.worlds
  SET play_count = play_count + 1
  WHERE id = _world_id AND status = 'approved';
$$;

GRANT EXECUTE ON FUNCTION public.bump_world_play_count(uuid) TO anon, authenticated;

-- 6. Indexes
CREATE INDEX worlds_status_sort_idx ON public.worlds (status, is_featured DESC, sort_order, created_at DESC);
CREATE INDEX worlds_creator_idx     ON public.worlds (creator_id);