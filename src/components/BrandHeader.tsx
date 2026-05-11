import edgeLogo from "@/assets/edge-esmeralda-logo.png";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";

interface BrandHeaderProps {
  title?: string;
  subtitle?: string;
  showPostButton?: boolean;
  onPost?: () => void;
  variant?: "floating" | "bar";
}

/**
 * Reusable Edge Esmeralda header.
 * - "floating": glass badge meant to sit on top of the map
 * - "bar":      full-width header for list pages (Events / Community)
 */
export default function BrandHeader({
  title = "Edge Esmeralda",
  subtitle = "Pop-up Village",
  showPostButton = false,
  onPost,
  variant = "bar",
}: BrandHeaderProps) {
  if (variant === "floating") {
    return (
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="absolute top-14 md:top-4 left-4 z-10 flex items-center gap-3 glass-panel rounded-2xl pl-2 pr-4 py-2 glow-mint-sm pointer-events-none select-none"
      >
        <img
          src={edgeLogo}
          alt=""
          className="h-10 w-10 object-contain drop-shadow-[0_0_12px_hsl(var(--mint-glow)/0.6)]"
        />
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            {subtitle}
          </span>
          <span
            className="font-display text-sm font-semibold text-gradient-mint"
            style={{ fontFamily: "'Sora', sans-serif" }}
          >
            {title}
          </span>
        </div>
      </motion.div>
    );
  }

  return (
    <header className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/50">
      <div className="flex items-center gap-2.5">
        <img
          src={edgeLogo}
          alt=""
          className="h-9 w-9 object-contain drop-shadow-[0_0_10px_hsl(var(--mint-glow)/0.5)]"
        />
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
            {subtitle}
          </span>
          <span
            className="font-display text-base font-semibold text-gradient-mint"
            style={{ fontFamily: "'Sora', sans-serif" }}
          >
            {title}
          </span>
        </div>
      </div>
      {showPostButton && (
        <button
          onClick={onPost}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground font-heading text-xs font-semibold px-3 py-2 rounded-lg hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3.5 h-3.5" />
          Post
        </button>
      )}
    </header>
  );
}
