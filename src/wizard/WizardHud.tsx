/**
 * Talking to the Wizard: a chat sheet with a mic, the world you are in, and
 * the remix button. Everything it does goes through the controller; this
 * file only draws.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { dictationSupported, say as speak, useDictation } from "@/build-mode/voice";
import type { WizardController } from "./controller";

const IDEAS = [
  "a giant friendly rubber duck",
  "a tiny castle with flags",
  "a glowing mushroom ring",
  "a rainbow arch over me",
  "a dragon who naps on a pile of gold",
  "a hot air balloon floating above",
];

const noop = () => () => {};

export default function WizardHud({
  wizard,
  open,
  onOpenChange,
}: {
  wizard: WizardController | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const snap = useSyncExternalStore(wizard?.subscribe ?? noop, () => wizard?.snapshot() ?? null);
  const [text, setText] = useState("");
  const [voiceOn, setVoiceOn] = useState(() => {
    try {
      return localStorage.getItem("wizard.voice") === "1";
    } catch {
      return false;
    }
  });
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"talk" | "world">("talk");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;

  const dictation = useDictation((t) => {
    setVoiceOn(true);
    void wizard?.wish(t);
  });

  useEffect(() => {
    if (!wizard) return;
    return wizard.onSpeak((t) => {
      if (voiceRef.current) speak(t);
    });
  }, [wizard]);

  useEffect(() => {
    try {
      localStorage.setItem("wizard.voice", voiceOn ? "1" : "0");
    } catch {
      /* fine */
    }
  }, [voiceOn]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: 1e6, behavior: "smooth" });
  }, [snap?.log.length, snap?.busy, open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  if (!wizard || !snap) return null;

  // Closed, he is just a man on the lawn: walk up to him, or use the menu.
  if (!open) return null;

  const submit = () => {
    const t = (dictation.listening ? dictation.interim : text).trim();
    if (!t) return;
    setText("");
    void wizard.wish(t);
  };

  const busyLine =
    snap.busy === "smart"
      ? "📜 Consulting the ancient scrolls…"
      : snap.busy === "fast"
        ? "✨ Weaving the spell…"
        : snap.busy === "remix"
          ? "🌀 Copying the whole world…"
          : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wizard.shareUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt("Copy this link", wizard.shareUrl());
    }
  };

  return (
    <div
      data-testid="wizard-panel"
      className="fixed bottom-3 left-3 z-[60] flex max-h-[min(70vh,560px)] w-[min(390px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-violet-300/30 bg-[#170b33]/90 text-violet-50 shadow-2xl shadow-black/50 backdrop-blur-md"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onOpenChange(false);
      }}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-xl">🧙</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-amber-100">The Wizard</div>
          <div className="truncate text-[11px] text-violet-200/80">
            {snap.world.shared ? "Shared island: everybody sees your wishes" : `Your remix: ${snap.world.name}`}
            {" · "}
            {snap.things} {snap.things === 1 ? "wish" : "wishes"} standing
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTab(tab === "talk" ? "world" : "talk")}
          className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-violet-100 hover:bg-white/10"
        >
          {tab === "talk" ? "🌍 World" : "💬 Talk"}
        </button>
        <button
          type="button"
          onClick={() => setVoiceOn(!voiceOn)}
          title={voiceOn ? "The Wizard speaks out loud" : "The Wizard is quiet"}
          className="rounded-full px-1.5 text-base hover:bg-white/10"
        >
          {voiceOn ? "🔊" : "🔈"}
        </button>
        <button type="button" onClick={() => onOpenChange(false)} className="rounded-full px-2 text-lg leading-none text-violet-200 hover:bg-white/10" aria-label="Close">
          ×
        </button>
      </div>

      {tab === "world" ? (
        <div className="flex flex-col gap-2 overflow-y-auto p-3 text-sm">
          <p className="text-violet-100/90">
            {snap.world.shared
              ? "This is the shared island. Every wish anybody makes here appears for everyone, live."
              : snap.world.mine
                ? "This is your own remix. Only you can wish here, but anybody with the link can visit, and remix it again."
                : `You are visiting ${snap.world.name}${snap.world.owner_name ? ` by ${snap.world.owner_name}` : ""}. Remix it to make your own copy.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!!snap.busy || snap.offline}
              onClick={() => void wizard.remix()}
              className="rounded-full bg-amber-300 px-3 py-1.5 text-xs font-semibold text-[#2a1600] hover:bg-amber-200 disabled:opacity-50"
            >
              🌀 Remix this world
            </button>
            {!snap.world.shared && (
              <>
                <button type="button" onClick={copy} className="rounded-full border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10">
                  {copied ? "Link copied!" : "🔗 Share link"}
                </button>
                <button
                  type="button"
                  onClick={() => void wizard.switchWorld("commons")}
                  className="rounded-full border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10"
                >
                  🏝 Back to the shared island
                </button>
              </>
            )}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wide text-violet-300/70">Recent wishes here</div>
          {snap.feed.length === 0 && <div className="text-xs text-violet-200/70">Nothing yet. Be the first!</div>}
          {snap.feed.map((f) => (
            <div key={f.id} className={`flex items-start gap-2 text-xs ${f.undone ? "opacity-40 line-through" : ""}`}>
              <span className="shrink-0 text-amber-200">{f.author}</span>
              <span className="min-w-0 flex-1 text-violet-100/90">{f.prompt}</span>
              {f.mine && (
                <button type="button" onClick={() => void wizard.undo(f.id)} className="shrink-0 text-[11px] text-violet-300 underline">
                  {f.undone ? "bring back" : "undo"}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div ref={logRef} className="flex min-h-[120px] flex-col gap-2 overflow-y-auto px-3 py-2 text-sm">
            {snap.log.length === 0 && (
              <div className="text-violet-100/90">
                <p>
                  Greetings, traveller! Tell me what you wish for and I shall conjure it right in front of you.
                  {snap.world.shared ? " Everybody on the island will see it." : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {IDEAS.map((i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => void wizard.wish(i)}
                      className="rounded-full border border-violet-300/30 bg-white/5 px-2.5 py-1 text-xs text-violet-100 hover:bg-white/15"
                    >
                      {i}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {snap.log.map((l, i) =>
              l.who === "system" ? (
                <div key={i} className="text-center text-[11px] text-violet-300/80">
                  {l.text}
                </div>
              ) : (
                <div key={i} className={l.who === "you" ? "self-end text-right" : "self-start"}>
                  <div
                    className={`inline-block max-w-[300px] rounded-2xl px-3 py-1.5 ${
                      l.who === "you" ? "bg-violet-500/40 text-white" : "bg-white/10 text-amber-50"
                    } ${l.undone ? "opacity-50" : ""}`}
                  >
                    {l.text}
                  </div>
                  {l.editId && (
                    <button type="button" onClick={() => void wizard.undo(l.editId!)} className="ml-2 text-[11px] text-violet-300 underline">
                      {l.undone ? "bring it back" : "undo"}
                    </button>
                  )}
                </div>
              ),
            )}
            {busyLine && <div className="animate-pulse self-start text-xs text-amber-200">{busyLine}</div>}
          </div>
          {!snap.world.mine && (
            <div className="mx-3 mb-1 rounded-lg bg-amber-300/15 px-2 py-1.5 text-xs text-amber-100">
              This is somebody else's world.{" "}
              <button type="button" className="font-semibold underline" onClick={() => void wizard.remix()}>
                Remix it
              </button>{" "}
              to make your own.
            </div>
          )}
          <form
            className="flex items-center gap-1.5 border-t border-white/10 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              ref={inputRef}
              value={dictation.listening ? dictation.interim : text}
              onChange={(e) => setText(e.target.value)}
              placeholder={dictation.listening ? "Listening…" : "I wish for…"}
              maxLength={600}
              className="min-w-0 flex-1 rounded-full border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-violet-200/50 focus:border-amber-200/60 focus:outline-none"
            />
            {dictationSupported() && (
              <button
                type="button"
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
                title="Say your wish"
                className={`rounded-full px-2.5 py-2 text-base ${dictation.listening ? "animate-pulse bg-rose-500/70" : "bg-white/10 hover:bg-white/20"}`}
              >
                🎙
              </button>
            )}
            <button
              type="submit"
              disabled={!!snap.busy}
              className="rounded-full bg-amber-300 px-3 py-2 text-sm font-semibold text-[#2a1600] hover:bg-amber-200 disabled:opacity-50"
            >
              Wish
            </button>
          </form>
          {dictation.error && <div className="px-3 pb-2 text-[11px] text-rose-300">{dictation.error}</div>}
        </>
      )}
    </div>
  );
}
