/**
 * tagGame — the "walk-into-someone" mini-game.
 *
 * v1 is intentionally local-first (no realtime state to sync): every time
 * your body collides with another *real* player's body, that counts as a
 * TAG. Rapid re-tags of the same person are suppressed by a per-target
 * cooldown, so hugging one friend doesn't spam the streak. If you go too
 * long between tags the streak decays back to 1 — the game rewards
 * chasing new people.
 *
 * The store is a tiny pub/sub so a React HUD can subscribe without
 * dragging in a state library.
 */
export interface TagState {
  streak: number;
  bestStreak: number;
  /** Name of the last player tagged (for the toast). */
  lastName: string | null;
  /** performance.now() when that tag happened, or 0. */
  lastTagAt: number;
  /** How long a streak survives without a new tag (ms). */
  decayMs: number;
}

export interface TagGame {
  /** Try to tag a player by their stable ref (usually their auth user_id).
   *  Returns true if the tag was actually registered. */
  tryTag: (ref: string, name: string) => boolean;
  state: () => TagState;
  subscribe: (fn: (s: TagState) => void) => () => void;
  /** Call each frame with performance.now(); handles streak decay. */
  tick: (nowMs: number) => void;
}

export function createTagGame(opts?: {
  perPlayerCooldownMs?: number;
  streakDecayMs?: number;
}): TagGame {
  const COOLDOWN = opts?.perPlayerCooldownMs ?? 8000;
  const DECAY = opts?.streakDecayMs ?? 20000;

  const cooldowns = new Map<string, number>();
  let state: TagState = {
    streak: 0,
    bestStreak: 0,
    lastName: null,
    lastTagAt: 0,
    decayMs: DECAY,
  };
  const subs = new Set<(s: TagState) => void>();
  const emit = () => {
    for (const fn of subs) fn(state);
  };

  return {
    tryTag(ref, name) {
      const now = performance.now();
      const cd = cooldowns.get(ref) ?? 0;
      if (now < cd) return false;
      cooldowns.set(ref, now + COOLDOWN);
      // Streak decay: if it's been too long since the last tag, reset.
      const nextStreak = state.lastTagAt && now - state.lastTagAt <= DECAY
        ? state.streak + 1
        : 1;
      state = {
        ...state,
        streak: nextStreak,
        bestStreak: Math.max(state.bestStreak, nextStreak),
        lastName: name,
        lastTagAt: now,
      };
      emit();
      return true;
    },
    state: () => state,
    subscribe(fn) {
      subs.add(fn);
      fn(state);
      return () => {
        subs.delete(fn);
      };
    },
    tick(nowMs) {
      if (state.streak > 0 && state.lastTagAt && nowMs - state.lastTagAt > DECAY) {
        state = { ...state, streak: 0 };
        emit();
      }
    },
  };
}
