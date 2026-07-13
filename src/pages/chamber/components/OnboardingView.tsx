import { AnimatePresence, motion } from "framer-motion";
import { FileText, Play, RotateCcw, Sparkles, Store } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { newMemberRecord, onboardingScript } from "../data/onboarding";
import { money } from "../theme";
import { JaneMeter, Rise, SectionHeading } from "./shared";

const AGENT_DELAY = 1600;
const REPLY_DELAY = 1100;

export const OnboardingView = () => {
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const [running, setRunning] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const done = shown >= onboardingScript.length;

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [shown, typing]);

  const run = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setShown(0);
    setRunning(true);
    let t = 400;
    onboardingScript.forEach((turn, i) => {
      if (turn.from === "agent") {
        timers.current.push(setTimeout(() => setTyping(true), t));
        t += AGENT_DELAY;
      } else {
        t += REPLY_DELAY;
      }
      timers.current.push(
        setTimeout(() => {
          setTyping(false);
          setShown(i + 1);
          if (i === onboardingScript.length - 1) setRunning(false);
        }, t),
      );
      t += 500;
    });
  };

  return (
    <div>
      <SectionHeading
        title="Onboarding Agent"
        subtitle="New businesses don't fill out a PDF. The Chamber's agent finds them, welcomes them, and signs them up in one conversation."
      />

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* Chat window */}
        <Rise>
          <div className="rounded-xl border border-border bg-card shadow-sm flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between bg-secondary/50">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground leading-none">Chamber onboarding agent</p>
                  <p className="text-[11px] text-muted-foreground mt-1">chatting with Solstice Ceramics Studio</p>
                </div>
              </div>
              <button
                onClick={run}
                disabled={running}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-all",
                  running
                    ? "bg-secondary text-muted-foreground cursor-wait"
                    : "bg-primary text-primary-foreground hover:opacity-90 shadow-sm",
                )}
              >
                {shown > 0 && !running ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {running ? "Playing…" : shown > 0 ? "Replay demo" : "Run demo"}
              </button>
            </div>
            <div ref={scrollRef} className="p-5 space-y-3 h-[430px] overflow-y-auto">
              {shown === 0 && !typing && (
                <p className="text-sm text-muted-foreground text-center pt-32">
                  Press <span className="font-semibold text-foreground">Run demo</span> to watch a new business join in one conversation.
                </p>
              )}
              {onboardingScript.slice(0, shown).map((turn, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className={cn("flex", turn.from === "business" && "justify-end")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                      turn.from === "agent"
                        ? "bg-secondary text-foreground rounded-tl-sm"
                        : "bg-primary text-primary-foreground rounded-tr-sm",
                    )}
                  >
                    {turn.text}
                  </div>
                </motion.div>
              ))}
              {typing && (
                <div className="flex">
                  <div className="rounded-2xl rounded-tl-sm bg-secondary px-4 py-3 flex gap-1">
                    {[0, 1, 2].map((d) => (
                      <motion.span
                        key={d}
                        className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ repeat: Infinity, duration: 1, delay: d * 0.18 }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Rise>

        {/* Payoff — record card materializes */}
        <div className="space-y-4">
          <AnimatePresence>
            {done ? (
              <>
                <motion.div
                  initial={{ opacity: 0, y: 24, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: "spring", damping: 18, stiffness: 220 }}
                  className="rounded-xl border border-primary/30 bg-card shadow-md p-6 relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 rounded-bl-xl bg-primary px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-primary-foreground">
                    New member
                  </div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{newMemberRecord.category}</p>
                  <h3 className="ch-serif text-2xl font-semibold text-foreground mt-1">{newMemberRecord.name}</h3>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                    <span className="text-muted-foreground">Owners</span><span className="text-foreground/90">{newMemberRecord.owners}</span>
                    <span className="text-muted-foreground">Address</span><span className="text-foreground/90">{newMemberRecord.address}</span>
                    <span className="text-muted-foreground">Plan</span><span className="text-foreground/90">{newMemberRecord.plan}</span>
                    <span className="text-muted-foreground">Jane Score</span><JaneMeter score={newMemberRecord.janeScore} />
                  </div>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.25, type: "spring", damping: 20 }}
                  className="rounded-xl border border-border bg-card shadow-sm p-5 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-accent" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">First invoice · {newMemberRecord.invoice.id}</p>
                      <p className="text-xs text-muted-foreground">{newMemberRecord.invoice.kind} · due {newMemberRecord.invoice.due}</p>
                    </div>
                  </div>
                  <span className="ch-serif text-xl font-semibold text-foreground tabular-nums">{money(newMemberRecord.invoice.amount)}</span>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.45, type: "spring", damping: 20 }}
                  className="rounded-xl border border-border bg-card shadow-sm p-5"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground flex items-center gap-1.5">
                    <Store className="h-3.5 w-3.5" /> Directory listing preview
                  </p>
                  <p className="ch-serif text-lg font-semibold text-foreground mt-2">{newMemberRecord.name}</p>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{newMemberRecord.listing}</p>
                  <p className="text-xs text-primary font-semibold mt-2">{newMemberRecord.email} · Locally owned</p>
                </motion.div>
              </>
            ) : (
              <Rise delay={0.1}>
                <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  The member record, first invoice, and directory listing will appear here when the conversation finishes.
                </div>
              </Rise>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
