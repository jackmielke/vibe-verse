import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import WorldHUD from "@/components/world/HUD";
import { createWorld, type WorldRuntime } from "@/world/engine";

export default function World() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [runtime, setRuntime] = useState<WorldRuntime | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = createWorld(canvas);
    setRuntime(w);
    // Drop the boot overlay once we've rendered a frame
    const t = setTimeout(() => setBooting(false), 250);
    return () => {
      clearTimeout(t);
      w.dispose();
    };
  }, []);

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-navy-deep">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full block cursor-crosshair"
      />
      <WorldHUD runtime={runtime} />

      <AnimatePresence>
        {booting && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="absolute inset-0 z-30 flex items-center justify-center bg-navy-deep"
          >
            <div className="text-center">
              <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="font-heading text-xs tracking-[0.3em] uppercase text-primary mb-1">
                Edge Esmeralda
              </p>
              <p className="font-heading text-lg">Spinning up the world…</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
