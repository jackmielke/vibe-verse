/**
 * VibeProfile — `/profile`, "My Vibe". What the top-right face opens.
 *
 * It used to be a grid of sixty-five emoji under a turntable, and it answered
 * none of the three questions somebody opening their profile is asking:
 * **who am I right now, what do I own, and where does any of it go.** The
 * emoji grid also listed the arcade's paid characters with no lock, so the
 * profile was quietly the one door where Grimlock was free.
 *
 * So it is the arcade shop's room now, pointed at you instead of at the stock:
 *
 *   - **The stage** is you: your character, wearing your hat and your
 *     stickers, on the same `CharacterPreview` the shop uses.
 *   - **Wardrobe** is what you own, and only that. Shopping is a link.
 *   - **Characters** is the picker, with real portraits, and locks on the
 *     paid ones that send you to the shop rather than putting them on.
 *   - **Stickers** edits the same `city.stickers` Vibe Island reads, so the
 *     sticker you place here is on your chest when you spawn there.
 *   - **Worlds** says plainly which worlds carry your character
 *     (`src/lib/characterReach.ts`), because "it follows you everywhere" was
 *     true of about a sixth of them.
 *
 * One WebGL context, like the shop: the stage is the only canvas, and every
 * grid on this page is still images.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Check, Loader2, Lock, LogOut, Pencil } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import VibeAvatar, { VIBE_COLORS } from "@/components/vibe-auth/VibeAvatar";
import { CharacterPreview } from "@/island/CharacterPreview";
import { DEFAULT_POSE, POSES, type PoseId } from "@/island/previewPose";
import type { CharacterOption } from "@/island/characters";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useActiveCharacter } from "@/hooks/use-active-character";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { supabase } from "@/integrations/supabase/client";
import { CHARACTERS, findCharacter, type CharSpec } from "@/lib/characters";
import { characterArt } from "@/lib/characterArt";
import { characterFace } from "@/lib/characterFaces";
import { SHOP_CHARACTERS, TIER_STYLE, byShelfOrder, shopCharacter } from "@/lib/characterShop";
import { CATALOG, type CosmeticItem, type FlameItem, type JetpackItem } from "@/lib/cosmeticCatalog";
import { equip, itemKey, type CosmeticKind } from "@/lib/wardrobe";
import { formatVibecoin } from "@/lib/vibecoin";
import { CHARACTER_REACH, REACH_LABEL, REACH_ORDER } from "@/lib/characterReach";
import { worldByKey } from "@/worlds/registry";
import { artFor } from "@/worlds/art";
import {
  STICKER_ART,
  STICKER_SLOTS,
  placeSticker,
  sanitizeStickers,
  type Sticker,
} from "@/components/city/stickers";

const MINT = "#7dffd4";
/** Vibe Island's key. Written here, read there on spawn. */
const STICKER_KEY = "city.stickers";

type Tab = "wardrobe" | "characters" | "stickers" | "worlds";
const TABS: { id: Tab; label: string; emoji: string }[] = [
  { id: "wardrobe", label: "Wardrobe", emoji: "🎒" },
  { id: "characters", label: "Characters", emoji: "🧑‍🚀" },
  { id: "stickers", label: "Stickers", emoji: "✨" },
  { id: "worlds", label: "Worlds", emoji: "🌐" },
];

const toOption = (c: CharSpec): CharacterOption => ({
  id: c.id,
  name: c.label,
  description: c.blurb,
  url: c.url,
  scale: 1,
  yOffset: 0,
  previewDistance: 2.7,
  previewHeight: 1.55,
  previewTarget: 1.25,
  accent: "",
});

function readStickers(): Sticker[] {
  try {
    return sanitizeStickers(JSON.parse(localStorage.getItem(STICKER_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

const KIND_LABEL: Record<CosmeticKind, string> = { hat: "Hats", jetpack: "Jetpacks", flame: "Flames" };

function swatch(kind: CosmeticKind, item: CosmeticItem): string | null {
  if (kind === "flame") return (item as FlameItem).color;
  if (kind === "jetpack") return (item as JetpackItem).trim;
  return null;
}

/** A character's picture: the shop portrait, else its face, else its emoji. */
function Portrait({ c, size = "card" }: { c: CharSpec; size?: "card" | "chip" }) {
  const src = characterArt(c.id) ?? characterFace(c.id);
  if (!src) {
    return (
      <div className={`grid h-full w-full place-items-center ${size === "card" ? "text-3xl" : "text-lg"}`} aria-hidden>
        {c.emoji}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="absolute inset-0 h-full w-full object-contain object-bottom p-1"
      style={{ filter: `drop-shadow(0 8px 16px ${c.accent}44)` }}
    />
  );
}

export default function VibeProfile() {
  const id = useVibeIdentity();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { balance } = useVibecoin();
  const { owned, loadout, refresh: refreshWardrobe } = useWardrobe();
  const { charId, setCharId } = useActiveCharacter();
  const me = findCharacter(charId);
  const myShop = shopCharacter(charId);

  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : "wardrobe";
  const setTab = (t: Tab) => setParams(t === "wardrobe" ? {} : { tab: t }, { replace: true });

  const [pose, setPose] = useState<PoseId>(DEFAULT_POSE);
  /* The stage's hat follows the loadout but moves on tap, like the shop's. */
  const [wornHat, setWornHat] = useState<string>(loadout.hat || "none");
  useEffect(() => setWornHat(loadout.hat || "none"), [loadout.hat]);

  const [stickers, setStickers] = useState<Sticker[]>(readStickers);
  const [stickerArt, setStickerArt] = useState<string>(STICKER_ART[0]);
  useEffect(() => {
    try {
      localStorage.setItem(STICKER_KEY, JSON.stringify(stickers));
    } catch {
      /* private mode */
    }
  }, [stickers]);

  // ---------- name ----------
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  useEffect(() => {
    setNameDraft(id.displayName === "Guest" ? "" : id.displayName);
  }, [id.displayName]);

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next) return;
    setSavingName(true);
    try {
      id.setGuestName(next);
      if (id.user) {
        const { error } = await supabase.from("users").update({ name: next }).eq("auth_user_id", id.user.id);
        if (error) throw error;
        await id.refresh();
      }
      toast.success("Saved");
      setEditingName(false);
    } catch (e: unknown) {
      toast.error((e as Error)?.message ?? "Couldn't save your name");
    } finally {
      setSavingName(false);
    }
  };

  // ---------- ownership ----------
  const ownsCharacter = useCallback(
    (cid: string) => !shopCharacter(cid) || owned.includes(itemKey("character", cid)),
    [owned],
  );
  const ownedOriginals = useMemo(
    () => [...SHOP_CHARACTERS].sort(byShelfOrder).filter((s) => owned.includes(itemKey("character", s.id))),
    [owned],
  );
  const freeRoster = useMemo(() => CHARACTERS.filter((c) => !shopCharacter(c.id)), []);
  const originals = useMemo(() => [...SHOP_CHARACTERS].sort(byShelfOrder).reverse(), []);

  const ownedItems = useMemo(() => {
    const out: Record<CosmeticKind, CosmeticItem[]> = { hat: [], jetpack: [], flame: [] };
    for (const kind of ["hat", "jetpack", "flame"] as CosmeticKind[]) {
      out[kind] = (CATALOG[kind] as CosmeticItem[]).filter(
        (it) => it.price <= 0 || owned.includes(itemKey(kind, it.id)),
      );
    }
    return out;
  }, [owned]);
  const notOwnedCount = useMemo(
    () =>
      (["hat", "jetpack", "flame"] as CosmeticKind[]).reduce(
        (n, k) => n + (CATALOG[k] as CosmeticItem[]).length - ownedItems[k].length,
        0,
      ),
    [ownedItems],
  );

  const wear = (c: CharSpec) => {
    if (!ownsCharacter(c.id)) {
      navigate(`/arcade/characters?c=${c.id}`);
      return;
    }
    setCharId(c.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const [busyItem, setBusyItem] = useState<string | null>(null);
  const putOn = async (kind: CosmeticKind, item: CosmeticItem) => {
    const key = itemKey(kind, item.id);
    setBusyItem(key);
    if (kind === "hat") setWornHat(item.id);
    try {
      await equip({ [kind]: item.id });
    } catch {
      toast.error("Couldn't put that on");
    } finally {
      setBusyItem(null);
      void refreshWardrobe();
    }
  };

  const accent = myShop ? TIER_STYLE[myShop.tier].color : me.accent || MINT;
  const tierLabel = myShop ? TIER_STYLE[myShop.tier].label : "Free";
  const displayName = id.displayName && id.displayName !== "Guest" ? id.displayName : "Guest";
  const option = useMemo(() => toOption(me), [me]);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-x-hidden bg-[#05070d] text-foreground">
      {/* The arcade's room: two washes and a scanline veil. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            `radial-gradient(65% 50% at 50% 0%, ${accent}22, transparent 70%),` +
            "radial-gradient(55% 45% at 84% 10%, hsl(280 90% 62% / 0.14), transparent 68%)",
          transition: "background 400ms ease",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.055]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, #fff 0px, #fff 1px, transparent 1px, transparent 3px)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-4 pb-20 pt-20 sm:px-6 sm:pt-24">
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
            className="inline-flex items-center gap-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
          <Link to="/arcade" className="flex items-center gap-2" title="Your Vibey Coins">
            <VibeCoinMark size={20} />
            <span className="font-heading text-sm font-black tabular-nums" style={{ color: MINT }}>
              {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
            </span>
          </Link>
        </div>

        <header className="mt-5 text-center">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] sm:text-[10px]" style={{ color: `${MINT}b3` }}>
            {id.user ? "Saved to your account" : "Guest · saved on this device"}
          </p>
          <h1
            className="mt-2 font-heading text-3xl font-black tracking-tight sm:text-5xl"
            style={{ color: "#fff", textShadow: "0 0 12px hsl(160 90% 60% / 0.85), 0 0 38px hsl(280 90% 62% / 0.45)" }}
          >
            MY VIBE
          </h1>
        </header>

        <div className="mt-7 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-8">
          {/* ---- The stage: you ---- */}
          <div className="relative lg:sticky lg:top-20">
            <div
              className="relative overflow-hidden rounded-3xl border bg-black/50 backdrop-blur-sm"
              style={{
                borderColor: `${accent}44`,
                boxShadow: `0 0 70px ${accent}1f, inset 0 0 0 1px ${accent}18`,
                transition: "border-color 400ms ease, box-shadow 400ms ease",
              }}
            >
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
                style={{ background: `radial-gradient(60% 100% at 50% 100%, ${accent}33, transparent 72%)` }}
                aria-hidden
              />
              <div className="relative h-[320px] sm:h-[400px]">
                <CharacterPreview character={option} spinning={false} pose={pose} hat={wornHat} stickers={stickers} />
              </div>
              <div
                className="absolute left-4 top-4 rounded-full px-2.5 py-1 font-heading text-[8.5px] font-black uppercase tracking-[0.2em]"
                style={{ color: accent, background: `${accent}1a`, border: `1px solid ${accent}55` }}
              >
                {tierLabel}
              </div>
              <div
                className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-heading text-[8.5px] font-black uppercase tracking-[0.2em]"
                style={{ color: MINT, borderColor: `${MINT}80`, background: `${MINT}1a` }}
              >
                <Check className="h-3 w-3" /> Playing as
              </div>
            </div>

            <div className="-mx-4 mt-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap sm:justify-center">
                {POSES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPose(p.id)}
                    aria-pressed={pose === p.id}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors ${
                      pose === p.id
                        ? "border-white/50 bg-white/10 text-foreground"
                        : "border-border/50 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span aria-hidden>{p.emoji}</span>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ---- The label ---- */}
            <div className="mt-4 text-center">
              <h2
                className="font-heading text-2xl font-black uppercase tracking-wide sm:text-3xl"
                style={{ color: accent, textShadow: `0 0 22px ${accent}55` }}
              >
                {me.emoji} {me.label}
              </h2>
              <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-foreground/70">
                {myShop?.pitch ?? me.blurb}
              </p>

              {editingName ? (
                <form
                  className="mx-auto mt-3 flex max-w-xs items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveName();
                  }}
                >
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder="What should we call you?"
                    maxLength={40}
                    className="h-10 flex-1 rounded-xl border border-white/15 bg-black/40 px-3 text-sm placeholder:text-white/30 focus:border-primary/60 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={savingName || !nameDraft.trim()}
                    className="h-10 rounded-xl bg-white px-4 text-sm font-semibold text-black disabled:opacity-40"
                  >
                    {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setEditingName(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-black/30 px-3 py-1.5 text-[11px] text-foreground/80 transition-colors hover:text-foreground"
                >
                  <VibeAvatar colorId={id.colorId} size={16} animated={false} />
                  {displayName}
                  <Pencil className="h-3 w-3 opacity-60" />
                </button>
              )}

              <div className="mx-auto mt-4 grid max-w-sm grid-cols-2 gap-2">
                <button
                  onClick={() => setTab("characters")}
                  className="rounded-xl px-3 py-3 font-heading text-[10.5px] font-black uppercase tracking-[0.12em] text-black transition-transform hover:scale-[1.02]"
                  style={{ background: accent, boxShadow: `0 0 26px ${accent}55` }}
                >
                  Change character
                </button>
                <Link
                  to="/city?spawn=island"
                  className="rounded-xl border border-border/60 bg-black/40 px-3 py-3 text-center font-heading text-[10.5px] font-black uppercase tracking-[0.12em] text-foreground transition-colors hover:bg-white/[0.06]"
                >
                  Vibe Island →
                </Link>
              </div>
            </div>
          </div>

          {/* ---- The locker ---- */}
          <div className="relative mt-8 lg:mt-0">
            <div className="flex gap-1 rounded-full border border-border/50 bg-black/40 p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  aria-pressed={tab === t.id}
                  className={`flex-1 rounded-full px-1.5 py-2 font-heading text-[9px] font-black uppercase tracking-[0.1em] transition-colors sm:text-[10px] ${
                    tab === t.id ? "bg-white text-black" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span aria-hidden className="mr-1 hidden sm:inline">
                    {t.emoji}
                  </span>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "wardrobe" && (
              <div className="mt-5 space-y-6">
                <section>
                  <SectionHead title="Characters you own" right={<Link to="/arcade/characters" className="hover:text-foreground">Shop originals →</Link>} />
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    <CharCard c={findCharacter(charId)} worn owned onClick={() => setTab("characters")} />
                    {ownedOriginals
                      .filter((s) => s.id !== charId)
                      .map((s) => (
                        <CharCard key={s.id} c={findCharacter(s.id)} owned tierColor={TIER_STYLE[s.tier].color} onClick={() => wear(findCharacter(s.id))} />
                      ))}
                    <button
                      onClick={() => setTab("characters")}
                      className="flex aspect-[4/5] flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-border/50 p-2 text-center transition-colors hover:border-[#7dffd4]/50 hover:bg-white/[0.03]"
                    >
                      <span className="font-heading text-lg font-black" style={{ color: MINT }}>
                        +{freeRoster.length}
                      </span>
                      <span className="font-heading text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                        Free to wear
                      </span>
                    </button>
                  </div>
                  {ownedOriginals.length === 0 && (
                    <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                      You haven't bought an Arcade original yet. Win Vibey Coins in the{" "}
                      <Link to="/arcade" className="text-primary hover:underline">Arcade</Link> and spend them in the{" "}
                      <Link to="/arcade/characters" className="text-primary hover:underline">shop</Link>.
                    </p>
                  )}
                </section>

                {(["hat", "jetpack", "flame"] as CosmeticKind[]).map((kind) => (
                  <section key={kind}>
                    <SectionHead
                      title={KIND_LABEL[kind]}
                      right={<span>{ownedItems[kind].length} owned</span>}
                    />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {ownedItems[kind].map((it) => {
                        const on = kind === "hat" ? wornHat === it.id : loadout[kind] === it.id;
                        const dot = swatch(kind, it);
                        const key = itemKey(kind, it.id);
                        return (
                          <button
                            key={it.id}
                            onClick={() => void putOn(kind, it)}
                            disabled={busyItem === key}
                            aria-pressed={on}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                              on ? "border-[#7dffd4]/70 bg-[#7dffd4]/10 text-foreground" : "border-border/50 bg-black/30 text-foreground/75 hover:text-foreground"
                            }`}
                          >
                            {dot ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} /> : <span aria-hidden>{it.emoji}</span>}
                            {it.name}
                            {on && <Check className="h-3 w-3" style={{ color: MINT }} />}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Hats show on the stage. Jetpacks and flames show when you fly in Vibe Island.{" "}
                  {notOwnedCount > 0 && (
                    <>
                      {notOwnedCount} more in the{" "}
                      <Link to="/arcade/characters?tab=items" className="text-primary hover:underline">shop</Link>.
                    </>
                  )}
                </p>
              </div>
            )}

            {tab === "characters" && (
              <div className="mt-5 space-y-6">
                <section>
                  <SectionHead title={`Arcade originals · ${originals.length}`} right={<Link to="/arcade/characters" className="hover:text-foreground">Open the shop →</Link>} />
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                    {originals.map((s) => {
                      const c = findCharacter(s.id);
                      const have = ownsCharacter(s.id);
                      return (
                        <CharCard
                          key={s.id}
                          c={c}
                          worn={charId === s.id}
                          owned={have}
                          price={have ? undefined : s.price}
                          tierColor={TIER_STYLE[s.tier].color}
                          onClick={() => wear(c)}
                        />
                      );
                    })}
                  </div>
                </section>
                <section>
                  <SectionHead title={`Free roster · ${freeRoster.length}`} right={<span>tap to wear</span>} />
                  <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                    {freeRoster.map((c) => (
                      <CharCard key={c.id} c={c} worn={charId === c.id} owned small onClick={() => wear(c)} />
                    ))}
                  </div>
                </section>
              </div>
            )}

            {tab === "stickers" && (
              <div className="mt-5 space-y-5">
                <div className="rounded-2xl border border-border/50 bg-black/30 p-4 text-[12px] leading-relaxed text-foreground/75">
                  <span className="font-heading text-[10px] font-black uppercase tracking-[0.18em]" style={{ color: MINT }}>
                    How stickers work
                  </span>
                  <p className="mt-1.5">
                    Pick a sticker, then tap a spot on your body. Tap the same spot again to peel it off. They
                    show on your character in Vibe Island, where other players can see them, and they're saved
                    on this device.
                  </p>
                </div>

                <section>
                  <SectionHead title="1 · Pick a sticker" />
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {STICKER_ART.map((a) => (
                      <button
                        key={a}
                        onClick={() => setStickerArt(a)}
                        aria-pressed={stickerArt === a}
                        className={`aspect-square rounded-xl border text-2xl transition-all ${
                          stickerArt === a ? "scale-[1.06] border-[#7dffd4]/70 bg-[#7dffd4]/10" : "border-border/50 bg-black/30 hover:bg-white/[0.04]"
                        }`}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <SectionHead
                    title="2 · Tap where it goes"
                    right={
                      stickers.length > 0 ? (
                        <button onClick={() => setStickers([])} className="hover:text-foreground">
                          Peel all off
                        </button>
                      ) : undefined
                    }
                  />
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {STICKER_SLOTS.map((slot) => {
                      const on = stickers.find((x) => x.slot === slot.id);
                      return (
                        <button
                          key={slot.id}
                          onClick={() =>
                            setStickers((l) =>
                              on && on.art === stickerArt
                                ? l.filter((x) => x.slot !== slot.id)
                                : placeSticker(l, { art: stickerArt, slot: slot.id }),
                            )
                          }
                          className={`flex items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-[11.5px] transition-colors ${
                            on ? "border-[#7dffd4]/60 bg-[#7dffd4]/10 text-foreground" : "border-border/50 bg-black/30 text-foreground/75 hover:text-foreground"
                          }`}
                        >
                          <span className="text-base" aria-hidden>
                            {on?.art ?? "·"}
                          </span>
                          {slot.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    The back and arm stickers face away from the camera. Pick the Spin pose to see them.
                  </p>
                </section>

                <Link
                  to="/city?spawn=island"
                  className="block w-full rounded-xl bg-primary px-4 py-3 text-center font-heading text-[11px] font-black uppercase tracking-[0.14em] text-primary-foreground transition-transform hover:scale-[1.02]"
                >
                  Show them off in Vibe Island →
                </Link>
              </div>
            )}

            {tab === "worlds" && (
              <div className="mt-5 space-y-6">
                <p className="text-[12px] leading-relaxed text-foreground/70">
                  Your character isn't in every world yet. Here's exactly where {me.label} goes with you.
                  Every world not listed uses its own built-in player.
                </p>
                {REACH_ORDER.map((r) => {
                  const list = CHARACTER_REACH.filter((e) => e.reach === r)
                    .map((e) => worldByKey(e.key))
                    .filter((w): w is NonNullable<typeof w> => !!w);
                  if (!list.length) return null;
                  return (
                    <section key={r}>
                      <SectionHead title={REACH_LABEL[r].title} right={<span>{list.length}</span>} />
                      <p className="mt-1 text-[11px] text-muted-foreground">{REACH_LABEL[r].blurb}</p>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {list.map((w) => {
                          const art = artFor(w.key);
                          return (
                            <Link
                              key={w.key}
                              to={w.route}
                              className="group relative flex h-16 items-end overflow-hidden rounded-xl border border-border/50 bg-black/40 p-2 transition-transform hover:-translate-y-0.5"
                            >
                              {art && (
                                <img
                                  src={art}
                                  alt=""
                                  loading="lazy"
                                  className="absolute inset-0 h-full w-full object-cover opacity-50 transition-opacity group-hover:opacity-70"
                                />
                              )}
                              <div className="absolute inset-0 bg-gradient-to-t from-black/85 to-transparent" aria-hidden />
                              <span className="relative truncate font-heading text-[10.5px] font-bold text-foreground">
                                {w.emoji} {w.name}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ---- Settings ---- */}
        <div className="mt-12 grid items-start gap-3 border-t border-border/40 pt-6 sm:grid-cols-2">
          <section className="rounded-2xl border border-border/50 bg-black/30 p-4">
            <div className="flex items-center justify-between">
              <SectionHead title="Vibe color" />
              <VibeAvatar colorId={id.colorId} size={28} animated={false} />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Your dot in chat and on the map.</p>
            <div className="mt-3 grid grid-cols-9 gap-1.5">
              {VIBE_COLORS.map((c) => {
                const active = id.colorId === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => id.setColor(c.id)}
                    className={`relative aspect-square rounded-lg border-2 transition-transform active:scale-95 ${active ? "border-white" : "border-white/10"}`}
                    style={{ background: c.hex }}
                    title={c.name}
                    aria-label={c.name}
                    aria-pressed={active}
                  >
                    {active && <Check className="absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-border/50 bg-black/30 p-4 text-[12px] leading-relaxed text-foreground/70">
            <SectionHead title="Account" />
            {id.user ? (
              <>
                <div className="mt-2 truncate text-xs text-white/70">{id.user.email}</div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Your character, coins and everything you own follow you to any device you sign in on.
                </p>
                <button
                  onClick={() => id.signOut()}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs text-rose-300 transition hover:text-rose-200"
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
              </>
            ) : (
              <p className="mt-2">
                You're playing as a guest. Your character and stickers are saved on this device. Sign in from the
                top right to keep your coins and everything you buy on every device.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="font-heading text-[11px] font-black uppercase tracking-[0.2em]" style={{ color: MINT }}>
        {title}
      </h3>
      {right && <span className="font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">{right}</span>}
    </div>
  );
}

function CharCard({
  c,
  worn = false,
  owned,
  price,
  tierColor,
  small = false,
  onClick,
}: {
  c: CharSpec;
  worn?: boolean;
  owned: boolean;
  price?: number;
  tierColor?: string;
  small?: boolean;
  onClick: () => void;
}) {
  const color = tierColor ?? c.accent ?? MINT;
  return (
    <button
      onClick={onClick}
      title={owned ? `Wear ${c.label}` : `${c.label} · ${price} Vibey Coins in the shop`}
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-black/45 text-left transition-transform hover:-translate-y-0.5 ${
        worn ? "ring-2" : ""
      }`}
      style={{
        borderColor: worn ? MINT : `${color}33`,
        boxShadow: worn ? `0 0 22px ${MINT}44` : `inset 0 0 0 1px ${color}14`,
        ["--tw-ring-color" as string]: `${MINT}88`,
      }}
    >
      <div
        className="relative aspect-[4/5] w-full overflow-hidden"
        style={{
          background: `radial-gradient(115% 78% at 50% 106%, ${color}55, transparent 64%), #0a0f1a`,
        }}
      >
        <Portrait c={c} size={small ? "chip" : "card"} />
        {!owned && <div className="absolute inset-0 bg-black/40" aria-hidden />}
        {worn && (
          <span
            className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-heading text-[7px] font-black uppercase tracking-[0.14em] text-black"
            style={{ background: MINT }}
          >
            <Check className="h-2.5 w-2.5" /> Wearing
          </span>
        )}
      </div>
      <div className={`flex items-center gap-1 px-2 ${small ? "py-1.5" : "py-2"}`}>
        <span className={`min-w-0 flex-1 truncate font-heading font-bold text-foreground ${small ? "text-[9px]" : "text-[10.5px]"}`}>
          {c.label}
        </span>
        {!owned && price != null && (
          <span className="flex shrink-0 items-center gap-0.5 font-heading text-[10px] font-black tabular-nums" style={{ color: MINT }}>
            <Lock className="h-2.5 w-2.5 opacity-70" />
            {price}
          </span>
        )}
      </div>
    </button>
  );
}
