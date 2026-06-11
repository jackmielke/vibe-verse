import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import edgeLogo from "@/assets/edge-esmeralda-logo.png";

interface SplashScreenProps {
  onEnter: () => void;
}

const SplashScreen = ({ onEnter }: SplashScreenProps) => {
  const [exiting, setExiting] = useState(false);

  // Auto-advance after a few seconds, but allow click-to-skip
  useEffect(() => {
    const t = setTimeout(() => handleEnter(), 4200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEnter = () => {
    if (exiting) return;
    setExiting(true);
    setTimeout(onEnter, 700);
  };

  return (
    <AnimatePresence>
      {!exiting && (
        <motion.div
          key="splash"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.05, filter: "blur(20px)" }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          onClick={handleEnter}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center cursor-pointer overflow-hidden"
          style={{
            background:
              "radial-gradient(ellipse at center, hsl(216 60% 18%) 0%, hsl(216 70% 8%) 70%, hsl(216 80% 4%) 100%)",
          }}
        >
          {/* Atmospheric mint glow halo behind the island */}
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1.6, ease: "easeOut" }}
            className="absolute"
            style={{
              width: "70vmin",
              height: "70vmin",
              background:
                "radial-gradient(circle, hsl(var(--mint-glow) / 0.35) 0%, hsl(var(--mint) / 0.12) 35%, transparent 70%)",
              filter: "blur(40px)",
            }}
          />

          {/* Subtle floating particles */}
          {Array.from({ length: 18 }).map((_, i) => (
            <motion.div
              key={i}
              className="absolute rounded-full"
              style={{
                width: 4 + Math.random() * 6,
                height: 4 + Math.random() * 6,
                background: "hsl(var(--mint-glow))",
                boxShadow: "0 0 12px hsl(var(--mint-glow))",
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                opacity: 0.4,
              }}
              animate={{
                y: [0, -20, 0],
                opacity: [0.2, 0.7, 0.2],
              }}
              transition={{
                duration: 4 + Math.random() * 4,
                repeat: Infinity,
                delay: Math.random() * 3,
                ease: "easeInOut",
              }}
            />
          ))}

          {/* Floating island with gentle bob */}
          <motion.div
            initial={{ y: 30, opacity: 0, scale: 0.85, filter: "blur(20px)" }}
            animate={{ y: 0, opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10"
          >
            <motion.img
              src={edgeLogo}
              alt="Edge Esmeralda floating village"
              className="w-[min(60vmin,460px)] h-[min(60vmin,460px)] object-contain select-none"
              style={{
                filter:
                  "drop-shadow(0 30px 60px hsl(var(--mint-glow) / 0.4)) drop-shadow(0 0 80px hsl(var(--mint) / 0.3))",
              }}
              animate={{ y: [0, -12, 0] }}
              transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
              draggable={false}
            />
          </motion.div>

          {/* Wordmark */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.9, ease: "easeOut" }}
            className="relative z-10 mt-2 flex flex-col items-center gap-3"
          >
            <div className="flex items-center gap-3 glass-panel rounded-full px-5 py-2 glow-mint-sm">
              <img src={edgeLogo} alt="" className="h-7 w-7 object-contain" />
              <span className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
                Pop-up Village
              </span>
            </div>
            <h1
              className="text-gradient-mint text-5xl md:text-6xl font-semibold tracking-tight"
              style={{ fontFamily: "'Sora', sans-serif" }}
            >
              Edge Esmeralda
            </h1>
            <p className="text-sm text-muted-foreground tracking-[0.2em] uppercase">
              A floating world, in session
            </p>
          </motion.div>

          {/* Tap to enter hint */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 2 }}
            onClick={(e) => {
              e.stopPropagation();
              handleEnter();
            }}
            className="absolute bottom-10 z-10 text-xs uppercase tracking-[0.32em] text-mint-glow/80 hover:text-mint-glow transition-colors"
          >
            <motion.span
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              Tap to enter
            </motion.span>
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SplashScreen;
