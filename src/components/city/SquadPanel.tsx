/**
 * The bodyguard HUD: a pill that opens the squad, three cards to hire and
 * send home, the five orders, a box to type an order into, and a button to
 * just talk to them.
 *
 * The voice is the Magician's own session (`src/magician/voice/session.ts`)
 * with a different cast and a different tool list, so it spends the same
 * free minutes per device and goes through the same edge function. It is
 * imported only when somebody presses Talk. Without it, the typed box runs
 * `parseSquadCommand`, which makes the same calls the model would.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Bodyguards, GuardId, GuardInfo, GuardOrder } from "@/city/bodyguards";
import {
  runSquadCall,
  runTypedOrder,
  SQUAD_BACKEND_PROMPT,
  SQUAD_GREETING,
  SQUAD_REALTIME_PROMPT,
  SQUAD_TOOLS,
  SQUAD_VOICE_PROMPT,
} from "@/city/squadCommands";
import type { VoiceSession, VoiceStatus } from "@/magician/voice/session";

const ORDERS: Array<{ order: GuardOrder; label: string }> = [
  { order: "follow", label: "🚶 Follow" },
  { order: "attack", label: "⚔️ Attack" },
  { order: "stay", label: "✋ Stay" },
  { order: "peace", label: "🕊️ Peace" },
  { order: "cheer", label: "🎉 Cheer" },
];

const NAME_PREFIX = /^\s*(kenji|hana|goro)\s*:\s*/i;

export function SquadPanel({ squad, hidden }: { squad: Bodyguards | null; hidden?: boolean }) {
  const [open, setOpen] = useState(false);
  const [guards, setGuards] = useState<GuardInfo[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState<string>("");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const voiceRef = useRef<VoiceSession | null>(null);
  const lastNotify = useRef(0);

  useEffect(() => {
    if (!squad) return;
    return squad.listen((e) => {
      if (e.kind === "hud") setGuards(e.guards);
      else if (e.important) {
        const v = voiceRef.current;
        const now = performance.now();
        if (v && v.status() === "live" && now - lastNotify.current > 6000) {
          lastNotify.current = now;
          v.notify(e.text);
        }
      }
    });
  }, [squad]);

  // B opens the squad (no modifiers, and never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyB" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => { voiceRef.current?.disconnect(); voiceRef.current = null; }, []);

  const startVoice = useCallback(async () => {
    if (!squad) return;
    if (voiceRef.current && (voiceRef.current.status() === "live" || voiceRef.current.status() === "connecting")) {
      voiceRef.current.disconnect();
      voiceRef.current = null;
      setStatus("closed");
      return;
    }
    if (!squad.roster().some((g) => g.hired)) squad.hire("all");
    const { createVoiceSession } = await import("@/magician/voice/session");
    const session = createVoiceSession({
      engine: "realtime",
      voice: "cedar",
      tools: SQUAD_TOOLS,
      prompts: { realtime: SQUAD_REALTIME_PROMPT, voice: SQUAD_VOICE_PROMPT, backend: SQUAD_BACKEND_PROMPT },
      greeting: SQUAD_GREETING,
      handlers: {
        onStatus: (s, d) => { setStatus(s); setDetail(d ?? ""); },
        onUserText: (t, final) => { if (final) setHeard(t); },
        onAssistantText: (t, final) => {
          setSaid(t);
          if (!final) return;
          const m = t.match(NAME_PREFIX);
          const who = (m ? m[1].toLowerCase() : undefined) as GuardId | undefined;
          const line = t.replace(NAME_PREFIX, "");
          squad.say(line.length > 70 ? line.slice(0, 67) + "..." : line, who);
        },
        onToolCall: (name, args) => runSquadCall(squad, name, args),
        onSpeaking: () => undefined,
        onListening: () => undefined,
        onLimit: (info) => {
          toast("The squad's radio is out of minutes", {
            description: info.day ? "Everybody's voice time for today is used up. Typed orders still work." : "Your free voice minutes are used up. Typed orders still work.",
          });
        },
      },
    });
    voiceRef.current = session;
    try {
      await session.connect();
    } catch (e) {
      toast("Couldn't reach the squad's radio", {
        description: `${e instanceof Error ? e.message : String(e)}. Typed orders still work.`,
      });
    }
  }, [squad]);

  const submit = () => {
    const t = text.trim();
    if (!t || !squad) return;
    setText("");
    setHeard(t);
    const v = voiceRef.current;
    if (v && v.status() === "live") { v.sendText(t); return; }
    const r = runTypedOrder(squad, t);
    if (r === null) toast("The squad didn't catch that", { description: "Try: protect me, attack, follow me, stay here, stand down, go home." });
    else setSaid(r);
  };

  if (!squad || hidden) return null;
  const hired = guards.filter((g) => g.hired);
  const fighting = hired.some((g) => g.fighting);
  const live = status === "live";
  const connecting = status === "connecting";

  return (
    <div className="fixed left-3 top-40 z-30 flex flex-col items-start gap-2 max-w-[calc(100vw-1.5rem)]" data-testid="squad">
      <button
        onClick={(e) => { setOpen((v) => !v); e.currentTarget.blur(); }}
        className={`glass-panel rounded-full px-3.5 py-2 text-xs flex items-center gap-1.5 transition-colors hover:bg-muted/50 ${fighting ? "border border-rose-400/60 shadow-[0_0_18px_rgba(244,63,94,0.45)]" : ""}`}
        title="Your bodyguards (B)"
        data-testid="squad-toggle"
      >
        <span>🥷 Squad</span>
        {hired.length > 0 && <span className="text-muted-foreground">{hired.map((g) => g.emoji).join("")}</span>}
        {fighting && <span className="text-rose-300">fighting</span>}
        {live && <span className="text-emerald-300">● on air</span>}
      </button>

      {open && (
        <div className="glass-panel rounded-2xl p-3 w-[19rem] max-w-full text-xs flex flex-col gap-2.5" data-testid="squad-panel">
          <div className="flex items-center justify-between">
            <span className="font-heading font-semibold text-sm">Samurai bodyguards</span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground px-1" aria-label="Close">✕</button>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {guards.map((g) => (
              <button
                key={g.id}
                onClick={(e) => { if (g.hired) squad.dismiss(g.id); else squad.hire(g.id); e.currentTarget.blur(); }}
                className={`rounded-xl px-2 py-2 flex flex-col items-center gap-0.5 border transition-colors ${g.hired ? "border-emerald-400/50 bg-emerald-500/10" : "border-border/40 hover:bg-muted/40"}`}
                data-testid={`squad-${g.id}`}
                title={g.hired ? `Send ${g.name} home` : `Call ${g.name}`}
              >
                <span className="text-lg leading-none">{g.emoji}</span>
                <span className="font-semibold">{g.name}</span>
                <span className="text-[10px] text-muted-foreground">{g.title}</span>
                <span className={`text-[10px] ${g.hired ? "text-emerald-300" : "text-muted-foreground"}`}>
                  {g.hired ? (g.loaded ? (g.fighting ? "fighting" : g.order) : "arriving") : "call"}
                  {g.wrecks > 0 ? ` · ${g.wrecks}🚓` : ""}
                </span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1">
            {ORDERS.map((o) => (
              <button
                key={o.order}
                onClick={(e) => { runSquadCall(squad, "command_bodyguards", { who: "all", order: o.order }); e.currentTarget.blur(); }}
                className={`rounded-full px-2.5 py-1 border transition-colors ${hired.length && hired.every((g) => g.order === o.order) ? "border-primary/60 bg-primary/15" : "border-border/40 hover:bg-muted/40"}`}
                data-testid={`squad-order-${o.order}`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="flex items-center gap-1.5"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={live ? "Say something to the squad..." : "Tell them: attack, stay here..."}
              className="flex-1 min-w-0 rounded-full bg-background/50 border border-border/40 px-3 py-1.5 outline-none focus:border-primary/60"
              data-testid="squad-input"
            />
            <button type="submit" className="rounded-full px-2.5 py-1.5 border border-border/40 hover:bg-muted/40">Go</button>
          </form>

          <button
            onClick={(e) => { void startVoice(); e.currentTarget.blur(); }}
            className={`rounded-full px-3 py-2 font-semibold transition-colors ${live ? "bg-rose-500/80 text-white" : "bg-primary/80 text-primary-foreground hover:bg-primary"}`}
            data-testid="squad-talk"
          >
            {live ? "■ Stop talking" : connecting ? "Connecting..." : "🎙️ Talk to your squad"}
          </button>
          {(status === "error" || status === "limit") && detail && <span className="text-rose-300">{detail}</span>}
          {(heard || said) && (
            <div className="flex flex-col gap-0.5 text-[11px]">
              {heard && <span className="text-muted-foreground">You: {heard}</span>}
              {said && <span>{said}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
