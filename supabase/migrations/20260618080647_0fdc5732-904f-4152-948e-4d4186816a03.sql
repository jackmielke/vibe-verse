ALTER TABLE public.world_agents REPLICA IDENTITY FULL;
ALTER TABLE public.world_messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.world_agents;
ALTER PUBLICATION supabase_realtime ADD TABLE public.world_messages;