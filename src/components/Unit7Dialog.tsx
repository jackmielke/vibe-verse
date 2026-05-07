import { motion, AnimatePresence } from "framer-motion";
import { X, Bot, Send } from "lucide-react";
import { useState } from "react";
import type { Unit7AnimName, Unit7Expression } from "./map/Unit7Layer";

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

// Naive keyword → behavior mapping. Good enough as a placeholder until we
// wire up an actual chat backend; the user gets immediate feedback that
// "talking" to Unit-7 changes his behavior or face.
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

export default function Unit7Dialog({ open, onClose, onEmote, onExpression }: Props) {
  const [text, setText] = useState("");
  const [activeExpr, setActiveExpr] = useState<Unit7Expression | null>(null);

  function handleSend() {
    const intent = inferIntent(text);
    if (intent.expr) {
      onExpression(intent.expr, 0.85);
      setActiveExpr(intent.expr);
    } else if (intent.anim) {
      onEmote(intent.anim);
    } else {
      onEmote("Wave");
    }
    setText("");
  }

  function toggleExpression(expr: Unit7Expression) {
    if (activeExpr === expr) {
      onExpression(expr, 0);
      setActiveExpr(null);
    } else {
      // Clear the previous one before applying the new one.
      if (activeExpr) onExpression(activeExpr, 0);
      onExpression(expr, 0.85);
      setActiveExpr(expr);
    }
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
            className="absolute inset-0 z-40 bg-background/50 backdrop-blur-[3px]"
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.94 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            className="absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(380px,calc(100vw-2rem))]"
          >
            <div className="glass-panel rounded-2xl overflow-hidden border border-primary/40 shadow-2xl relative">
              <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full blur-3xl bg-primary/30 pointer-events-none" />

              <button
                onClick={onClose}
                className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-muted/60 hover:bg-muted flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>

              <div className="relative p-6 pb-3 text-center">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 border border-primary/40 mb-3">
                  <Bot className="w-6 h-6 text-primary" />
                </div>
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                  Resident Bot
                </p>
                <h2 className="font-heading text-2xl font-bold text-foreground leading-tight mt-1">
                  Unit-7
                </h2>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  Wandering the village. Tell him something, pick an emote, or change his mood.
                </p>
              </div>

              <div className="relative px-5 pb-2 grid grid-cols-3 gap-2">
                {QUICK_EMOTES.map((e) => (
                  <button
                    key={e.anim}
                    onClick={() => onEmote(e.anim)}
                    className="rounded-lg border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 transition-colors px-2 py-2 text-xs font-medium"
                  >
                    {e.label}
                  </button>
                ))}
              </div>

              <div className="relative px-5 pb-2 pt-1">
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-2">
                  Mood
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {FACE_EXPRESSIONS.map((e) => (
                    <button
                      key={e.expr}
                      onClick={() => toggleExpression(e.expr)}
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

              <div className="relative px-5 pb-5 pt-3 flex gap-2">
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
