/**
 * Battle bots: the data, the match rules, the challenge link and the result
 * card for /bots.
 *
 * There is no table. Your bot lives in localStorage; a challenge link carries
 * the challenger's bot inside the URL; the match is played on the device
 * against that bot's own throwing style; the card is drawn on a canvas. The
 * only server call is `bot-forge`, which writes the bot.
 */
import { supabase } from "@/integrations/supabase/client";

export type Throw = "rock" | "paper" | "scissors";
export const THROWS: Throw[] = ["rock", "paper", "scissors"];
export const THROW_EMOJI: Record<Throw, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
const BEATS: Record<Throw, Throw> = { rock: "scissors", paper: "rock", scissors: "paper" };

export interface Bot {
  v: 1;
  handle: string;
  name: string;
  emoji: string;
  species: string;
  color: string;
  catchphrase: string;
  personality: string;
  style: Record<Throw, number>;
  tell: string;
  win: string;
  lose: string;
  stats: { grit: number; flair: number; cunning: number };
}

const KEY = "vibe.bot.v1";

export function loadBot(): Bot | null {
  try {
    const b = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return b?.v === 1 ? b : null;
  } catch {
    return null;
  }
}

export function saveBot(b: Bot | null): void {
  try {
    if (b) localStorage.setItem(KEY, JSON.stringify(b));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the bot lasts the visit */
  }
}

export async function forgeBot(handle: string, bio: string): Promise<Bot> {
  const { data, error } = await supabase.functions.invoke("bot-forge", { body: { handle, bio } });
  if (error || !data?.bot) throw new Error(data?.error ?? error?.message ?? "the forge is cold");
  return data.bot as Bot;
}

// ---------------------------------------------------------------------------
// Challenge links: the bot rides in the URL as base64url JSON
// ---------------------------------------------------------------------------

export function encodeBot(b: Bot): string {
  const bytes = new TextEncoder().encode(JSON.stringify(b));
  let s = "";
  bytes.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBot(code: string): Bot | null {
  try {
    const s = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
    const b = JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0))));
    if (b?.v !== 1 || typeof b.name !== "string" || !b.style) return null;
    return b as Bot;
  } catch {
    return null;
  }
}

export const challengeUrl = (b: Bot) => `${window.location.origin}/bots?vs=${encodeBot(b)}`;

// ---------------------------------------------------------------------------
// The match: first to three. You coach your bot's throw; theirs throws by style.
// ---------------------------------------------------------------------------

export const FIRST_TO = 3;

export function outcome(a: Throw, b: Throw): 1 | 0 | -1 {
  return a === b ? 0 : BEATS[a] === b ? 1 : -1;
}

/** Weighted pick from a bot's style. `r` is 0..1. */
export function styleThrow(b: Bot, r: number): Throw {
  const total = THROWS.reduce((s, t) => s + b.style[t], 0);
  let x = r * total;
  for (const t of THROWS) {
    x -= b.style[t];
    if (x <= 0) return t;
  }
  return "scissors";
}

export const favourite = (b: Bot): Throw => THROWS.reduce((a, t) => (b.style[t] > b.style[a] ? t : a), "rock" as Throw);

// ---------------------------------------------------------------------------
// The result card: 1080 x 1350, drawn here, shared as a PNG
// ---------------------------------------------------------------------------

export async function drawCard(me: Bot, them: Bot, myScore: number, theirScore: number): Promise<Blob> {
  const W = 1080, H = 1350;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  const won = myScore > theirScore;

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#120a1f");
  bg.addColorStop(1, "#05060f");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  g.textAlign = "center";
  g.fillStyle = won ? "#7dffd4" : "#ff8a7a";
  g.font = "900 64px system-ui, sans-serif";
  g.fillText(won ? "VICTORY" : "DEFEAT", W / 2, 140);
  g.fillStyle = "rgba(255,255,255,0.55)";
  g.font = "600 30px system-ui, sans-serif";
  g.fillText("BOT BATTLE · ROCK PAPER SCISSORS", W / 2, 190);

  const side = (b: Bot, x: number, score: number, winner: boolean) => {
    g.save();
    g.shadowColor = b.color;
    g.shadowBlur = winner ? 60 : 0;
    g.beginPath();
    g.arc(x, 520, 190, 0, Math.PI * 2);
    g.fillStyle = b.color + (winner ? "40" : "22");
    g.fill();
    g.lineWidth = 10;
    g.strokeStyle = b.color + (winner ? "" : "66");
    g.stroke();
    g.restore();
    g.font = "220px system-ui, 'Apple Color Emoji', sans-serif";
    g.fillText(b.emoji, x, 600);
    g.fillStyle = "#fff";
    g.font = "800 50px system-ui, sans-serif";
    g.fillText(b.name, x, 790, 460);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.font = "500 30px system-ui, sans-serif";
    g.fillText(`@${b.handle}`, x, 840, 460);
    g.fillStyle = "#fff";
    g.font = "900 150px system-ui, sans-serif";
    g.fillText(String(score), x, 1010);
  };
  side(me, 280, myScore, won);
  side(them, 800, theirScore, !won);
  g.fillStyle = "rgba(255,255,255,0.4)";
  g.font = "800 60px system-ui, sans-serif";
  g.fillText("VS", W / 2, 540);

  const champ = won ? me : them;
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.font = "italic 600 40px system-ui, sans-serif";
  g.fillText(`“${champ.catchphrase || champ.win}”`, W / 2, 1140, 960);
  g.fillStyle = "#ffb23f";
  g.font = "700 34px system-ui, sans-serif";
  g.fillText("Build yours in 30 seconds · myvibeverse.com/bots", W / 2, 1270, 1000);

  return new Promise((res) => cv.toBlob((b) => res(b!), "image/png"));
}

/** Share sheet with the card attached where the browser allows it, else download. */
export async function shareCard(blob: Blob, text: string, url: string): Promise<void> {
  const file = new File([blob], "bot-battle.png", { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], text: `${text} ${url}` }).catch(() => {});
    return;
  }
  if (nav.share) {
    await nav.share({ text, url }).catch(() => {});
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bot-battle.png";
  a.click();
}
