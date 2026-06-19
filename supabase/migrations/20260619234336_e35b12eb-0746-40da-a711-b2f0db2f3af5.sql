
GRANT UPDATE (name) ON public.world_agents TO authenticated;

DROP POLICY IF EXISTS "Admins can rename world agents" ON public.world_agents;
CREATE POLICY "Admins can rename world agents"
ON public.world_agents
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));
