-- 1. Drop the two policies that exposed everything to the world
DROP POLICY IF EXISTS "Edge functions can access custom tools" ON public.custom_tools;
DROP POLICY IF EXISTS "Edge functions can update custom tools for metrics" ON public.custom_tools;

-- 2. Revoke read/write access to the secret column from anon + authenticated roles.
--    Service role (used by edge functions) bypasses both RLS and column grants, so it keeps full access.
REVOKE SELECT (auth_value) ON public.custom_tools FROM anon, authenticated;
REVOKE UPDATE (auth_value) ON public.custom_tools FROM anon, authenticated;

-- 3. Re-grant SELECT/UPDATE on all OTHER columns to authenticated so the existing
--    "Community members can view enabled custom tools" and
--    "Community admins can manage custom tools" policies keep working for non-secret fields.
GRANT SELECT (
  id, community_id, name, display_name, description, endpoint_url, http_method,
  auth_type, parameters, request_template, response_mapping, is_enabled, icon,
  category, last_test_at, last_test_result, error_count, last_error,
  rate_limit_per_hour, timeout_seconds, created_at, updated_at
) ON public.custom_tools TO authenticated;

GRANT UPDATE (
  community_id, name, display_name, description, endpoint_url, http_method,
  auth_type, parameters, request_template, response_mapping, is_enabled, icon,
  category, last_test_at, last_test_result, error_count, last_error,
  rate_limit_per_hour, timeout_seconds, updated_at
) ON public.custom_tools TO authenticated;