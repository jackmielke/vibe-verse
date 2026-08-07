/**
 * The rules for the six-digit sign-in code.
 *
 * Small, pure, and separate from the dialog for one reason: the auto-submit
 * rule is the kind of thing that is easy to write, easy to get subtly wrong,
 * and expensive when it is. A self-submitting form that retries a rejected code
 * on every render hammers the auth endpoint — and Supabase rate-limits OTP
 * verification, so the punishment for the loop is that the user cannot sign in
 * at all, for an hour, with no explanation. Better to name the rule and test it
 * than to leave it inline in an effect.
 */

/** How many digits the code is. Supabase issues six. */
export const OTP_LENGTH = 6;

/**
 * Digits only, capped at the code length.
 *
 * People paste `429-173`, `Code: 429173`, and codes with a stray trailing
 * space out of an email client. All of those are the same code.
 */
export function normalizeOtp(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

export function isCompleteOtp(raw: string): boolean {
  return normalizeOtp(raw).length === OTP_LENGTH;
}

export interface AutoSubmitState {
  /** Whatever is currently in the box, unnormalised. */
  code: string;
  /** The code we last sent to the server, or null if we have sent none. */
  lastTried: string | null;
  /** Are we on the code screen at all? */
  sent: boolean;
  /** Is a request already in flight? */
  loading: boolean;
}

/**
 * Should the form submit itself right now?
 *
 * True exactly once per distinct complete code. The `lastTried` comparison is
 * the whole guard: after a rejection the box still holds six digits, so without
 * it every subsequent render would fire another attempt. Comparing the *value*
 * rather than setting a one-way "already tried" flag means a corrected code
 * submits on its own too, which is what people expect after a typo.
 */
export function shouldAutoSubmit({ code, lastTried, sent, loading }: AutoSubmitState): boolean {
  if (!sent || loading) return false;
  const token = normalizeOtp(code);
  if (token.length !== OTP_LENGTH) return false;
  return token !== lastTried;
}
