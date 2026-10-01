/**
 * The iOS app's safety surface: the terms you agree to before anything else,
 * a small shield that opens report/block for whoever is on screen, and the
 * sheet itself. Mounted once in `App`, and only inside the app — the website
 * is unchanged.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { IOS_APP } from "@/lib/iosApp";
import { haptic } from "@/lib/haptics";
import { IOS_HIDDEN_ROUTES } from "@/worlds/registry";
import {
  REPORT_REASONS,
  type SafetyTarget,
  acceptTerms,
  block,
  blockedList,
  clearSafetyLists,
  isBlocked,
  onOpenSafety,
  report,
  safetyContent,
  safetyPeers,
  safetyVersion,
  subscribeSafety,
  termsAccepted,
  unblock,
} from "./safety";

const CONTACT = "jackcmielke@gmail.com";

/** Routes outside the registry that the app also leaves out: money, admin, framed third-party games. */
const IOS_HIDDEN_EXACT = new Set([
  "/wallet", "/vibe", "/coin", "/arcade", "/shop", "/cosmos", "/build", "/build-a-game",
  "/submit-game", "/submit-a-game", "/homes", "/unit7", "/looks",
]);
const IOS_HIDDEN_PREFIXES = ["/play/", "/join/", "/admin", "/arcade/", "/shop/", "/homes/"];

const useSafety = () => useSyncExternalStore(subscribeSafety, safetyVersion);

export default function SafetyLayer() {
  if (!IOS_APP) return null;
  return <SafetyLayerInner />;
}

function SafetyLayerInner() {
  useSafety();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<SafetyTarget | undefined>();

  const navigate = useNavigate();
  useEffect(() => clearSafetyLists(), [pathname]);
  // Every button and link answers the finger, the way a native app does.
  useEffect(() => {
    const onTap = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.("button, a, [role=button]")) haptic("light");
    };
    window.addEventListener("pointerdown", onTap, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", onTap, { capture: true });
  }, []);
  // A deep link into something the app leaves out goes home instead.
  useEffect(() => {
    if (IOS_HIDDEN_ROUTES.has(pathname) || IOS_HIDDEN_EXACT.has(pathname) || IOS_HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
      navigate("/", { replace: true });
    }
  }, [pathname, navigate]);
  useEffect(
    () =>
      onOpenSafety((t) => {
        setFocus(t);
        setOpen(true);
      }),
    [],
  );

  // The gate links to the terms and privacy policy, so those two must be readable before agreeing.
  if (!termsAccepted() && pathname !== "/terms" && pathname !== "/privacy") return <TermsGate />;

  const anyone = safetyPeers().list.length > 0 || safetyContent().list.length > 0;

  return (
    <>
      {anyone && !open && (
        <button
          aria-label="Safety: report or block a player"
          onClick={() => {
            setFocus(undefined);
            setOpen(true);
          }}
          className="fixed z-[2147483000] flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-black/55 text-base text-white backdrop-blur"
          style={{ left: 12, bottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        >
          🛡️
        </button>
      )}
      {open && <SafetySheet focus={focus} onClose={() => setOpen(false)} />}
    </>
  );
}

const panel =
  "fixed inset-0 z-[2147483001] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center";
const card =
  "max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-white/10 bg-[#0d0f1c] p-5 text-white shadow-2xl sm:rounded-2xl";
const btn = "rounded-lg px-3 py-1.5 text-xs font-semibold";

function TermsGate() {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className={panel} style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className={card} style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}>
        <h2 className="text-xl font-bold">Welcome to the Vibe Verse</h2>
        <p className="mt-2 text-sm text-white/70">
          Some worlds are multiplayer: you will see other players' names and the things they write. Before you
          go in, please agree to the community terms.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-white/85">
          <li>• <b>Zero tolerance</b> for objectionable content or abusive users: no harassment, hate, sexual content, threats, or spam.</li>
          <li>• Tap the 🛡️ shield, a name, or a message to <b>report</b> it or <b>block</b> that player. Blocked players disappear for you immediately.</li>
          <li>• Every report is reviewed within 24 hours. Offending content is removed and the player who posted it is removed from the Vibe Verse.</li>
          <li>• Contact: {CONTACT}</li>
        </ul>
        <p className="mt-3 text-xs text-white/50">
          These terms are in addition to Apple's standard End User License Agreement.{" "}
          <a className="underline" href="/terms">Full terms</a> · <a className="underline" href="/privacy">Privacy</a>
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="h-4 w-4" />
          I agree to the terms and the zero-tolerance policy.
        </label>
        <button
          disabled={!agreed}
          onClick={acceptTerms}
          className="mt-4 w-full rounded-xl bg-[#7dffd4] py-3 font-bold text-black disabled:opacity-40"
        >
          Enter
        </button>
      </div>
    </div>
  );
}

function SafetySheet({ focus, onClose }: { focus?: SafetyTarget; onClose: () => void }) {
  useSafety();
  const [reporting, setReporting] = useState<SafetyTarget | undefined>(focus?.text || focus?.name ? undefined : undefined);
  const [selected, setSelected] = useState<SafetyTarget | undefined>(focus);
  const peers = safetyPeers().list.filter((p) => !isBlocked(p.name, p.id));
  const content = safetyContent()
    .list.filter((c) => !isBlocked(c.name, c.id))
    .slice(-15)
    .reverse();
  const blocked = blockedList();

  const doBlock = (t: SafetyTarget) => {
    block(t);
    haptic("success");
    toast.success(`Blocked ${t.name ?? "player"}. You won't see them anymore.`);
    setSelected(undefined);
  };

  if (reporting) return <ReportDialog target={reporting} onDone={() => setReporting(undefined)} />;

  return (
    <div className={panel} onClick={onClose}>
      <div className={card} onClick={(e) => e.stopPropagation()} style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">🛡️ Safety</h2>
          <button onClick={onClose} className="text-sm text-white/60">Close</button>
        </div>

        {selected && (selected.name || selected.text) && (
          <div className="mt-4 rounded-xl border border-white/15 bg-white/5 p-3">
            {selected.name && <div className="font-semibold">{selected.name}</div>}
            {selected.text && <div className="mt-1 text-sm text-white/80">“{selected.text}”</div>}
            <div className="mt-3 flex gap-2">
              <button className={`${btn} bg-amber-400 text-black`} onClick={() => setReporting(selected)}>Report</button>
              {selected.name && (
                <button className={`${btn} bg-red-500 text-white`} onClick={() => doBlock(selected)}>Block {selected.name}</button>
              )}
            </div>
          </div>
        )}

        <Section title="Players here">
          {peers.length === 0 && <Empty>Nobody else is here right now.</Empty>}
          {peers.map((p) => (
            <Row key={(p.id ?? "") + p.name} label={p.name} onReport={() => setReporting(p)} onBlock={() => doBlock(p)} />
          ))}
        </Section>

        {content.length > 0 && (
          <Section title="Recent messages">
            {content.map((c) => (
              <Row
                key={c.at + c.text}
                label={c.name ?? "Someone"}
                sub={c.text}
                onReport={() => setReporting(c)}
                onBlock={c.name ? () => doBlock(c) : undefined}
              />
            ))}
          </Section>
        )}

        <Section title="Blocked">
          {blocked.length === 0 && <Empty>You haven't blocked anyone.</Empty>}
          {blocked.map((b) => (
            <div key={b.name} className="flex items-center justify-between py-1.5 text-sm">
              <span>{b.name}</span>
              <button className={`${btn} bg-white/10`} onClick={() => unblock(b.name)}>Unblock</button>
            </div>
          ))}
        </Section>

        <p className="mt-5 text-xs text-white/50">
          Reports are reviewed within 24 hours. Contact {CONTACT} · <a className="underline" href="/terms">Terms</a>
        </p>
      </div>
    </div>
  );
}

function ReportDialog({ target, onDone }: { target: SafetyTarget; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async (reason: string) => {
    setBusy(true);
    const ok = await report(target, reason);
    setBusy(false);
    haptic(ok ? "success" : "error");
    if (ok) toast.success("Thanks. We review every report within 24 hours.");
    else toast.error(`Couldn't send the report. Email ${CONTACT} and we'll handle it.`);
    onDone();
  };
  return (
    <div className={panel} onClick={onDone}>
      <div className={card} onClick={(e) => e.stopPropagation()} style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}>
        <h2 className="text-lg font-bold">Report {target.name ?? "content"}</h2>
        {target.text && <p className="mt-1 text-sm text-white/70">“{target.text}”</p>}
        <p className="mt-3 text-sm text-white/70">What's wrong?</p>
        <div className="mt-2 grid gap-2">
          {REPORT_REASONS.map((r) => (
            <button key={r} disabled={busy} onClick={() => submit(r)} className="rounded-xl bg-white/10 px-4 py-3 text-left text-sm disabled:opacity-40">
              {r}
            </button>
          ))}
        </div>
        <button onClick={onDone} className="mt-3 w-full py-2 text-sm text-white/60">Cancel</button>
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mt-5">
    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-white/45">{title}</div>
    {children}
  </div>
);

const Empty = ({ children }: { children: React.ReactNode }) => <div className="py-1.5 text-sm text-white/45">{children}</div>;

function Row({ label, sub, onReport, onBlock }: { label: string; sub?: string; onReport: () => void; onBlock?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-white/60">{sub}</div>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button className={`${btn} bg-amber-400/90 text-black`} onClick={onReport}>Report</button>
        {onBlock && <button className={`${btn} bg-red-500/90 text-white`} onClick={onBlock}>Block</button>}
      </div>
    </div>
  );
}
