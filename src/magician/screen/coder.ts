/**
 * Asking for a screen program: the page's side of `vibe-magician-screen`.
 *
 * The function streams the code back as plain text, so this reads it chunk
 * by chunk and hands each growing draft to `onDraft`, which is what lets the
 * screen show the code being written while it is written. supabase-js has
 * no streaming invoke, so this is a plain fetch with the same headers.
 */
import { supabase } from "@/integrations/supabase/client";
import { deviceId } from "../voice/session";

export interface Program { code: string; title: string; model: string }

export class CoderError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) { super(message); }
}

/** Strip what a model adds around code however firmly it is asked not to. */
export function cleanCode(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
  if (fence) s = fence[1];
  else s = s.replace(/^```(?:js|javascript)?\s*\n?/i, "").replace(/```\s*$/, "");
  return s.trim();
}

export function titleOf(code: string, fallback: string): string {
  const m = code.match(/^\s*\/\/\s*Title:\s*(.+)$/im);
  return (m?.[1] ?? fallback).trim().slice(0, 48);
}

export async function writeProgram(
  req: { request: string; previous?: string | null; error?: string | null },
  onDraft: (code: string) => void,
  signal?: AbortSignal,
): Promise<Program> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vibe-magician-screen`;
  const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  let token = anon;
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) token = data.session.access_token;
  } catch { /* signed out is fine */ }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: anon },
    body: JSON.stringify({ action: "write", request: req.request, previous: req.previous ?? null, error: req.error ?? null, device: deviceId() }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    let msg = `The coder answered ${resp.status}`;
    let code: string | null = null;
    try { const j = await resp.json(); msg = j.error ?? msg; code = j.code ?? null; } catch { /* not JSON */ }
    throw new CoderError(msg, code, resp.status);
  }
  const model = resp.headers.get("X-Model") ?? "";
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  let lastDraft = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    const now = performance.now();
    if (now - lastDraft > 80) { lastDraft = now; onDraft(cleanCode(text)); }
  }
  const code = cleanCode(text);
  if (!/function\s+draw\s*\(/.test(code)) throw new CoderError("The coder did not write a draw() function.", "nodraw", 200);
  return { code, title: titleOf(code, req.request), model };
}
