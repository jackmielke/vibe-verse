-- =========================================================
-- USER_LOCATIONS TABLE
-- =========================================================
CREATE TYPE public.location_sharing_mode AS ENUM ('off', 'precise', 'approximate');

CREATE TABLE public.user_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  sharing_mode public.location_sharing_mode NOT NULL DEFAULT 'off',
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_locations_active
  ON public.user_locations (sharing_mode, expires_at)
  WHERE sharing_mode <> 'off';

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

-- Helper: does the viewer share any community with the location's owner?
CREATE OR REPLACE FUNCTION public.viewer_shares_community_with_user(_other_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.community_members cm_self
    JOIN public.users u_self ON u_self.id = cm_self.user_id
    JOIN public.community_members cm_other
      ON cm_other.user_id = _other_user_id
     AND cm_other.community_id = cm_self.community_id
    WHERE u_self.auth_user_id = auth.uid()
  );
$$;

CREATE POLICY "Users can view their own location"
  ON public.user_locations FOR SELECT
  TO authenticated
  USING (user_id = public.get_user_id_from_auth(auth.uid()));

CREATE POLICY "Community peers can view active shared locations"
  ON public.user_locations FOR SELECT
  TO authenticated
  USING (
    sharing_mode <> 'off'
    AND (expires_at IS NULL OR expires_at > now())
    AND user_id <> public.get_user_id_from_auth(auth.uid())
    AND public.viewer_shares_community_with_user(user_id)
  );

CREATE POLICY "Users can insert their own location"
  ON public.user_locations FOR INSERT
  TO authenticated
  WITH CHECK (user_id = public.get_user_id_from_auth(auth.uid()));

CREATE POLICY "Users can update their own location"
  ON public.user_locations FOR UPDATE
  TO authenticated
  USING (user_id = public.get_user_id_from_auth(auth.uid()));

CREATE POLICY "Users can delete their own location"
  ON public.user_locations FOR DELETE
  TO authenticated
  USING (user_id = public.get_user_id_from_auth(auth.uid()));

-- Auto-update updated_at on row updates
CREATE TRIGGER trg_user_locations_updated_at
  BEFORE UPDATE ON public.user_locations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();