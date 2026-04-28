import { motion, AnimatePresence } from "framer-motion";
import { X, Send, Sparkles } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const VIBEY_TG_URL = "https://t.me/vibey_ai_bot";

export default function VibeyDialog({ open, onClose }: Props) {
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
            className="absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(360px,calc(100vw-2rem))]"
          >
            <div className="glass-panel rounded-2xl overflow-hidden border border-primary/40 shadow-2xl relative">
              <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full blur-3xl bg-primary/30 pointer-events-none" />

              <button
                onClick={onClose}
                className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-muted/60 hover:bg-muted flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>

              <div className="relative p-6 pb-4 text-center">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 border border-primary/40 mb-3">
                  <Sparkles className="w-6 h-6 text-primary" />
                </div>
                <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                  Community Agent
                </p>
                <h2 className="font-heading text-2xl font-bold text-foreground leading-tight mt-1">
                  Hey, I'm Vibey
                </h2>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  Your AI companion for Edge Esmeralda. Ask me anything about events,
                  people, or the village — anytime.
                </p>
              </div>

              <div className="relative px-6 pb-6 pt-2">
                <a
                  href={VIBEY_TG_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-heading text-sm font-semibold py-3 rounded-xl hover:opacity-90 transition-opacity"
                >
                  <Send className="w-4 h-4" />
                  Message Vibey on Telegram
                </a>
                <p className="text-[10px] text-center text-muted-foreground mt-3 font-mono">
                  t.me/vibey_ai_bot
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
