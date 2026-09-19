/**
 * Keeping the lights on, gently.
 *
 * The voice costs real money per minute. After ten free minutes a visitor
 * is asked, once, to chip in; they may keep going either way. Donations go
 * through a Stripe Payment Link where the visitor chooses the amount and
 * can leave a name and a line, and the names go on the supporters' board by
 * the bridge in Hoshimura, which reads from `vibe_magician_supporters`.
 *
 * Until a Stripe webhook is wired, the board is a guestbook: the visitor
 * signs it themselves after donating, and the board says "as told to us".
 */
import { supabase } from "@/integrations/supabase/client";

// The generated Database types predate this table; a narrow untyped view of
// the client is honest about that without reaching for `any` everywhere.
interface Loose {
  from(table: string): {
    select(cols: string): { order(col: string, o: { ascending: boolean }): { limit(n: number): Promise<{ data: unknown[] | null; error: unknown }> } };
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
  };
}
const db = supabase as unknown as Loose;

/** The Stripe Payment Link. Public by nature; a customer-chosen amount. */
export const DONATE_URL = "https://donate.stripe.com/bJe14g8nvayve1Y4kO93y00";

export interface Supporter {
  id: string;
  name: string;
  message: string;
  amount_cents: number | null;
  verified: boolean;
  created_at: string;
}

export async function loadSupporters(limit = 40): Promise<Supporter[]> {
  try {
    const { data, error } = await db
      .from("vibe_magician_supporters")
      .select("id, name, message, amount_cents, verified, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as Supporter[];
  } catch {
    return [];
  }
}

export async function signBoard(name: string, message: string, amountCents: number | null, deviceId: string): Promise<boolean> {
  const n = name.trim().slice(0, 40);
  const m = message.trim().slice(0, 140);
  if (!n) return false;
  try {
    const { error } = await db.from("vibe_magician_supporters").insert({ name: n, message: m, amount_cents: amountCents, verified: false, device_id: deviceId });
    return !error;
  } catch {
    return false;
  }
}

/** Open the donation page, remembering that this device meant to. */
export function openDonate(): void {
  if (!DONATE_URL) return;
  try { localStorage.setItem("magician.donated", String(Date.now())); } catch { /* fine */ }
  window.open(DONATE_URL, "_blank", "noopener");
}

export function recentlyDonated(): boolean {
  try {
    const t = Number(localStorage.getItem("magician.donated") ?? 0);
    return Date.now() - t < 30 * 60 * 1000;
  } catch {
    return false;
  }
}
