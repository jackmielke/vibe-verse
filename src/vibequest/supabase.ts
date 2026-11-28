/**
 * VibeQuest keeps its own backend.
 *
 * The game came from its own Lovable project (github.com/jackmielke/VibeQuest),
 * and its character roster, the uploaded character images, the online fighter
 * channel and the ElevenLabs boss music all live in that project's Supabase,
 * not the vibeverse's. So this is a second, separate client pointed at it.
 *
 * The key is the public anon key (role "anon"), the same one the original
 * site ships in its bundle. It never signs anybody in: persistSession is off
 * so it cannot collide with the vibeverse session in localStorage.
 */
import { createClient } from "@supabase/supabase-js";

export const VIBEQUEST_SUPABASE_URL = "https://lnxjkeaawolwjuwygzdv.supabase.co";
export const VIBEQUEST_SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueGprZWFhd29sd2p1d3lnemR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE3NTk1NzcsImV4cCI6MjA3NzMzNTU3N30.JhCQEGPMP0fW5A5CYdXQ8phNW4ScIfgqY79CXmYdwZk";

export const supabase = createClient(VIBEQUEST_SUPABASE_URL, VIBEQUEST_SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: "vibequest-auth" },
});
