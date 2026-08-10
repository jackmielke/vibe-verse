/**
 * SPLASH ROYALE — multiplayer transport contract.
 *
 * This lives here rather than in `royale/types.ts` because the battle-royale
 * engine contract predates the water fight and is shared with the shipped,
 * single-player `/drop-zero` route. Networking is an *addition*: every system
 * reads `ctx.services.net` lazily and null-checks it, exactly the way it
 * already null-checks `storm` or `loot`, so a build with no net system (or a
 * net system that never came online) is still a complete game.
 *
 * The augmentation at the bottom is what puts `net` on `WorldServices`
 * without touching the file that declares it.
 */

/** Gameplay messages peers must see. Deliberately small and closed. */
export type NetEventKind =
  /** A water-gun trigger pull — stream origin/direction, for tracers. */
  | "shot"
  /** A stream or balloon landed somewhere: wet decal + splash particles. */
  | "splash"
  /** A water balloon was thrown (arc is re-simulated locally from the throw). */
  | "balloon"
  /** Glue gun: two players tethered, or a glue puddle placed. */
  | "glue"
  /** A structure piece was placed. */
  | "build"
  /** Something was harvested for materials. */
  | "harvest"
  /**
   * Water landed on a specific player, sent by the shooter to the victim.
   *
   * `splash` is scenery — a decal and some particles, addressed to nobody.
   * This is the one that costs dryness, and it is the difference between a
   * lobby where you can see each other and a lobby where you can play each
   * other. Addressed: the payload carries the victim's peer id and only that
   * client acts on it.
   *
   * Client-authoritative on the victim, deliberately. Nobody can be soaked by
   * a packet alone — your own client decides what your dryness is, exactly as
   * it already does for `soaked`. That trades cheat-resistance for having no
   * server at all, which is the same trade every other event here makes.
   */
  | "hit"
  /** A player hit 0% dry and is out. */
  | "soaked"
  /** A downed squadmate was towelled off. */
  | "revive"
  | "emote"
  | "chat"
  /** Map/world ping for squad comms. */
  | "ping";

/** Every kind, in one place, so a UI can enumerate them. */
export const NET_EVENT_KINDS: readonly NetEventKind[] = [
  "shot",
  "splash",
  "balloon",
  "glue",
  "build",
  "harvest",
  "hit",
  "soaked",
  "revive",
  "emote",
  "chat",
  "ping",
] as const;

/** What the local player publishes about itself, ~10 times a second. */
export interface NetPose {
  x: number;
  y: number;
  z: number;
  /** Radians. */
  yaw: number;
  pitch: number;
  /**
   * Movement state. Kept as a plain string rather than the engine's
   * `PlayerState` union: SPLASH ROYALE adds states (`stumble`, `glued`) that the
   * DROP ZERO contract does not know about, and a transport should not be
   * the thing that blocks a new one.
   */
  state: string;
  /** How dry the sender is, 0..100. 100 = bone dry, 0 = soaked and out. */
  dry: number;
  /** Squad id. Same string = same squad = do not soak each other. */
  team?: string;
}

/**
 * A remote player, as the renderer should draw them *this frame*.
 *
 * The position/yaw/pitch fields are already interpolated — read them
 * straight into a ghost's transform. The raw packets that produced them are
 * not exposed; dead-reckoning is the transport's problem, not the caller's.
 */
export interface PeerState {
  id: string;
  name: string;
  team: string | null;
  /** True when this peer is an AI teammate (Claude) rather than a human. */
  agent: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  state: string;
  dry: number;
  /** `ctx.elapsed` when the last packet from this peer arrived. */
  lastSeen: number;
  /**
   * True once at least one pose has arrived. Peers known only from presence
   * have no position yet and must not be drawn at the origin.
   */
  posed: boolean;
}

export interface ChatLine {
  id: string;
  /** Peer id of the sender; equals `net.selfId` for our own lines. */
  from: string;
  name: string;
  text: string;
  /** `ctx.elapsed` at receipt — simulated seconds, not wall clock. */
  t: number;
  self: boolean;
  agent: boolean;
}

/** Who we are when we join. */
export interface NetProfile {
  name: string;
  team?: string;
  /** Set by the Claude teammate so peers can badge it as an AI. */
  agent?: boolean;
}

/**
 * The transport. Every method is safe to call while offline — that is the
 * whole point. `join()` resolving false is a normal outcome, not an error:
 * the match carries on solo against bots.
 */
export interface NetService {
  /** False when offline/solo. Never throws, never blocks. */
  readonly online: boolean;
  /** The lobby code players share, e.g. "SPLASH-4B2". Null until joined. */
  readonly roomCode: string | null;
  /** Stable id for this browser tab, used as the presence key. */
  readonly selfId: string;
  /**
   * The squad we joined as, or null when we have no team.
   *
   * Needed because friendly fire has to be refused by the *shooter*: a
   * teammate should never receive a `hit` packet at all, and the only way to
   * know one is a teammate is to know our own squad. `peers` never contains
   * us, so without this there is nothing to compare against.
   */
  readonly selfTeam: string | null;
  /** Live remote players, already interpolated. Do not mutate. */
  readonly peers: Map<string, PeerState>;
  /** Join (or create) a room. Resolves false when Supabase is unreachable. */
  join(roomCode: string, profile: NetProfile): Promise<boolean>;
  leave(): void;
  /**
   * Local player pose. Cheap — call it every frame. The transport decides
   * when to actually put bytes on the wire (~10 Hz, and only on change).
   */
  publishPose(p: NetPose): void;
  /** Fire-and-forget gameplay event. No-op offline. */
  send(kind: NetEventKind, payload: unknown): void;
  /** Subscribe to a kind. Returns an unsubscribe function. */
  on(kind: NetEventKind, fn: (from: string, payload: unknown) => void): () => void;
  /** Say something. Echoes into `messages` immediately, online or not. */
  chat(text: string): void;
  /** Rolling chat backlog, oldest first. Do not mutate. */
  readonly messages: ChatLine[];
}

declare module "../types" {
  interface WorldServices {
    /**
     * Multiplayer transport. Absent when the net system was not booted;
     * present-but-offline when Supabase could not be reached. Both cases
     * mean "play solo", and every consumer must handle them the same way.
     */
    net?: NetService;
  }
}
