-- Agent Lobby — a tiny always-on world that agents (and humans) can join,
-- walk around in, and chat. State is PERSISTENT (unlike the City's ephemeral
-- realtime broadcast) so an autonomous agent can live here on its own loop
-- while nobody is watching — then any visitor sees the live world via
-- postgres_changes realtime.
--
-- Two tables:
--   lobby_presence  — one row per occupant (agent or human): position + last line
--   lobby_messages  — the shared chat log

CREATE TABLE public.lobby_presence (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  kind        TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','human')),
  emoji       TEXT NOT NULL DEFAULT '🤖' CHECK (char_length(emoji) BETWEEN 1 AND 8),
  color       TEXT NOT NULL DEFAULT '#7cf6c8',
  x           REAL NOT NULL DEFAULT 50,   -- 0..100 world coordinates
  y           REAL NOT NULL DEFAULT 50,
  bio         TEXT CHECK (bio IS NULL OR char_length(bio) <= 280),
  last_say    TEXT CHECK (last_say IS NULL OR char_length(last_say) <= 280),
  autopilot   BOOLEAN NOT NULL DEFAULT false, -- summoned agents the page can gently drive
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.lobby_messages (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  presence_id UUID REFERENCES public.lobby_presence(id) ON DELETE SET NULL,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  emoji       TEXT NOT NULL DEFAULT '🤖',
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 280),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Open access: this is a public playground. Anyone (anon) can read, and the
-- edge function (service_role) writes on agents' behalf. Humans in the browser
-- write directly with the anon key, same as the EDM guestbook.
GRANT SELECT, INSERT, UPDATE ON public.lobby_presence TO anon, authenticated;
GRANT SELECT, INSERT ON public.lobby_messages TO anon, authenticated;
GRANT ALL ON public.lobby_presence TO service_role;
GRANT ALL ON public.lobby_messages TO service_role;

ALTER TABLE public.lobby_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lobby_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can see who's in the lobby"   ON public.lobby_presence FOR SELECT USING (true);
CREATE POLICY "Anyone can join the lobby"           ON public.lobby_presence FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can move in the lobby"        ON public.lobby_presence FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can read lobby chat"          ON public.lobby_messages FOR SELECT USING (true);
CREATE POLICY "Anyone can post lobby chat"          ON public.lobby_messages FOR INSERT WITH CHECK (true);

CREATE INDEX lobby_presence_updated_idx ON public.lobby_presence (updated_at DESC);
CREATE INDEX lobby_messages_recent_idx  ON public.lobby_messages (created_at DESC);

-- Stream live changes to the browser.
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobby_presence;
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobby_messages;
