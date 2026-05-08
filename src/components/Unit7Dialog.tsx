import { motion, AnimatePresence } from "framer-motion";
import { X, Send, Rocket } from "lucide-react";
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import type { Unit7AnimName, Unit7Expression } from "./map/Unit7Layer";
import Unit7Stage from "./Unit7Stage";

interface Props {
  open: boolean;
  onClose: () => void;
  onEmote: (anim: Unit7AnimName) => void;
  onExpression: (expr: Unit7Expression, intensity: number) => void;
}

const QUICK_EMOTES: { label: string; anim: Unit7AnimName }[] = [
  { label: "👋 Wave", anim: "Wave" },
  { label: "💃 Dance", anim: "Dance" },
  { label: "👍 Thumbs Up", anim: "ThumbsUp" },
  { label: "✅ Yes", anim: "Yes" },
  { label: "❌ No", anim: "No" },
  { label: "🦘 Jump", anim: "Jump" },
];

const FACE_EXPRESSIONS: { label: string; expr: Unit7Expression }[] = [
  { label: "😠 Angry", expr: "Angry" },
  { label: "😮 Surprised", expr: "Surprised" },
  { label: "😢 Sad", expr: "Sad" },
];

// Keyword → emote/expression intent. Until there's a real chat backend, this
// gives Unit-7 enough behavioral hooks that "talking" to him feels alive.
function inferIntent(text: string): { anim?: Unit7AnimName; expr?: Unit7Expression } {
  const t = text.toLowerCase();
  if (/\b(angry|mad|furious|grr)\b/.test(t)) return { expr: "Angry" };
  if (/\b(surprised|wow|whoa|omg)\b/.test(t)) return { expr: "Surprised" };
  if (/\b(sad|sorry|bummed|miss)\b/.test(t)) return { expr: "Sad" };
  if (/\b(hi|hello|hey|sup|yo)\b/.test(t)) return { anim: "Wave" };
  if (/\b(dance|party|groove|vibe)\b/.test(t)) return { anim: "Dance" };
  if (/\b(yes|yeah|yep|ok|okay|sure|cool|nice|love it|awesome)\b/.test(t)) return { anim: "Yes" };
  if (/\b(no|nope|nah|never)\b/.test(t)) return { anim: "No" };
  if (/\b(thumbs?|good job|well done|gg)\b/.test(t)) return { anim: "ThumbsUp" };
  if (/\b(jump|hop|leap)\b/.test(t)) return { anim: "Jump" };
  if (/\b(punch|fight|hit)\b/.test(t)) return { anim: "Punch" };
  if (/\b(sit|rest)\b/.test(t)) return { anim: "Sitting" };
  return {};
}

const NEUTRAL: Record<Unit7Expression, number> = { Angry: 0, Surprised: 0, Sad: 0 };

export default function Unit7Dialog({ open, onClose, onEmote, onExpression }: Props) {
  const [text, setText] = useState("");
  const [activeExpr, setActiveExpr] = useState<Unit7Expression | null>(null);

  // Local mirror of Unit-7 state for the in-dialog 3D stage. Both this AND
  // the map character receive the same emote/expression updates.
  const [stageAnim, setStageAnim] = useState<Unit7AnimName>("Wave");
  const [stagePulse, setStagePulse] = useState(0);
  const [stageExpr, setStageExpr] = useState<Record<Unit7Expression, number>>(NEUTRAL);

  // When the dialog opens, kick off a Wave hello on the stage.
  useEffect(() => {
    if (open) {
      setStageAnim("Wave");
      setStagePulse((p) => p + 1);
      setStageExpr(NEUTRAL);
      setActiveExpr(null);
    }
  }, [open]);

  function triggerEmote(anim: Unit7AnimName) {
    onEmote(anim);
    setStageAnim(anim);
    setStagePulse((p) => p + 1);
  }

  function triggerExpression(expr: Unit7Expression) {
    if (activeExpr === expr) {
      // Toggle off.
      onExpression(expr, 0);
      setStageExpr(NEUTRAL);
      setActiveExpr(null);
    } else {
      // Clear previous (if any) on the map state too.
      if (activeExpr) onExpression(activeExpr, 0);
      onExpression(expr, 0.85);
      setStageExpr({ ...NEUTRAL, [expr]: 0.85 });
      setActiveExpr(expr);
    }
  }

  function handleSend() {
    const intent = inferIntent(text);
    if (intent.expr) {
      // Fire as if the mood button was pressed.
      if (activeExpr !== intent.expr) {
        if (activeExpr) onExpression(activeExpr, 0);
        onExpression(intent.expr, 0.85);
        setStageExpr({ ...NEUTRAL, [intent.expr]: 0.85 });
        setActiveExpr(intent.expr);
      }
    } else if (intent.anim) {
      triggerEmote(intent.anim);
    } else {
      triggerEmote("Wave");
    }
    setText("");
  }

  function handleStageOneShotEnd() {
    // After a one-shot finishes on the stage, drop back to Idle.
    setStageAnim("Idle");
    setStagePulse((p) => p + 1);
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 z-40 bg-background/60 backdrop-blur-[3px]"
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.94 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            className="absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100vw-2rem))]"
          >
            <div className="glass-panel rounded-2xl overflow-hidden border border-primary/40 shadow-2xl relative">
              <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full blur-3xl bg-primary/30 pointer-events-none" />

              <button
                onClick={onClose}
                className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-muted/60 hover:bg-muted flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>

              {/* 3D close-up stage */}
              <div className="relative px-4 pt-4">
                <Unit7Stage
                  currentAnim={stageAnim}
                  animPulse={stagePulse}
                  expressions={stageExpr}
                  onOneShotEnd={handleStageOneShotEnd}
                />
              </div>

              <div className="relative px-6 pt-3 pb-1 text-center">
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                  Resident Bot
                </p>
                <h2 className="font-heading text-2xl font-bold text-foreground leading-tight">
                  Unit-7
                </h2>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  Tap a reaction or change his mood. He'll do it here and out in the village.
                </p>
              </div>

              <div className="relative px-5 pt-2 grid grid-cols-3 gap-2">
                {QUICK_EMOTES.map((e) => (
                  <button
                    key={e.anim}
                    onClick={() => triggerEmote(e.anim)}
                    className="rounded-lg border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-2 py-2 text-xs font-medium"
                  >
                    {e.label}
                  </button>
                ))}
              </div>

              <div className="relative px-5 pt-3 pb-2">
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-2">
                  Mood
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {FACE_EXPRESSIONS.map((e) => (
                    <button
                      key={e.expr}
                      onClick={() => triggerExpression(e.expr)}
                      className={`rounded-lg border transition-colors px-2 py-2 text-xs font-medium ${
                        activeExpr === e.expr
                          ? "border-primary/60 bg-primary/20 text-primary"
                          : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                      }`}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative px-5 pt-2">
                <Link
                  to="/unit7"
                  onClick={onClose}
                  className="w-full flex items-center justify-center gap-2 bg-primary/15 hover:bg-primary/25 transition-colors text-primary font-heading text-xs font-semibold py-2 rounded-lg"
                >
                  <Rocket className="w-3.5 h-3.5" />
                  Open Unit-7's outer-space playground
                </Link>
              </div>

              <div className="relative px-5 pb-5 pt-2 flex gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && text.trim()) handleSend();
                  }}
                  placeholder="Say hi, ask him to dance, look surprised…"
                  className="flex-1 rounded-lg bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-3 py-2 text-sm"
                />
                <button
                  onClick={handleSend}
                  disabled={!text.trim()}
                  className="bg-primary text-primary-foreground px-3 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
