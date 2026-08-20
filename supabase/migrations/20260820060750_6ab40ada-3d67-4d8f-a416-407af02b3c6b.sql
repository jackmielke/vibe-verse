ALTER TABLE public.empyrean_notes REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.empyrean_notes;