/**
 * VibeCoinPanel — live ticker + simple calculator for $VIBE.
 *
 * Pulls price/FDV/24h-change/volume from GeckoTerminal's public pool
 * API (no key, no auth). The pool we point at is the canonical VIBE
 * pool on Base. Refreshes every 60s while mounted; throttles network
 * calls when the tab is hidden.
 *
 * The component renders ONE card:
 *   - top half: price + market cap + 24h change pill (animated)
 *   - bottom half: bidirectional USD ↔ VIBE calculator
 *
 * If the API is unreachable we fall back to a friendly "Couldn't fetch
 * live data" message — the rest of the lobby stays unaffected.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { TrendingUp, TrendingDown, Coins, RefreshCw } from "lucide-react";

// Source of truth: GeckoTerminal's canonical $VIBE pool on Base.
// Jack prefers the pool view's headline number (~$92K FDV) over
// CoinGecko's circulating-supply-adjusted market cap (~$8K) — the
// pool number is what the community sees when they pull up the
// chart themselves, so the app should match.
const VIBE_TOKEN_ADDRESS = "0x7255ecf1020a95fed5323dd4feb23a54ab1aa7d1";
const VIBE_NETWORK = "base";
// The canonical pool — same one linked at
// https://www.geckoterminal.com/base/pools/0xc3ad...
const VIBE_POOL_ADDRESS = "0xc3ad498815597f1e6f71d3cb1166856e947efb46";
const POOL_ENDPOINT = `https://api.geckoterminal.com/api/v2/networks/${VIBE_NETWORK}/pools/${VIBE_POOL_ADDRESS}`;

interface VibeStats {
  priceUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  fetchedAt: number;
}

// GeckoTerminal serializes numbers as strings sometimes; make this safe.
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

async function fetchVibe(): Promise<VibeStats | null> {
  try {
    const res = await fetch(POOL_ENDPOINT, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const a = json?.data?.attributes as Record<string, unknown> | undefined;
    if (!a) return null;
    const priceUsd =
      num(a.base_token_price_usd) ?? num((a as Record<string, unknown>).token_price_usd);
    if (priceUsd == null) return null;
    return {
      priceUsd,
      // We headline FDV as "market cap" because that's what the pool
      // reports and what the community looks at. CoinGecko's
      // smaller circulating-cap is suppressed here on purpose.
      marketCapUsd: num(a.fdv_usd),
      fdvUsd: num(a.fdv_usd),
      circulatingSupply: null, // pool endpoint doesn't expose this
      totalSupply: null,
      liquidityUsd: num(a.reserve_in_usd),
      volume24h: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      priceChange24h: num((a.price_change_percentage as Record<string, unknown> | undefined)?.h24),
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// Pretty-print a USD figure with the right magnitude suffix.
function fmtUsd(n: number | null, opts: { compact?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (opts.compact && Math.abs(n) >= 1000) {
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  }
  // Sub-cent precision for tiny token prices.
  if (Math.abs(n) < 0.01) {
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: 6,
      maximumFractionDigits: 8,
    })}`;
  }
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

// Compact number formatter (no $ prefix) for supply / count stats.
function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

function fmtCompact(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function VibeCoinPanel() {
  const [stats, setStats] = useState<VibeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pulse, setPulse] = useState(0); // bumps on every successful refresh

  // Calculator: drive both sides off whichever the user last edited.
  // We keep raw strings (not numbers) so the user can type "0." mid-flow.
  const [usdInput, setUsdInput] = useState("100");
  const [vibeInput, setVibeInput] = useState("");
  const lastEdited = useRef<"usd" | "vibe">("usd");

  // Initial fetch + 60s polling. We also pause polling when the tab
  // is hidden — no point hammering the API for nobody.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const s = await fetchVibe();
      if (cancelled) return;
      if (s) {
        setStats(s);
        setError(false);
        setPulse((p) => p + 1);
      } else {
        setError(true);
      }
      setLoading(false);
    };
    run();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Recompute the dependent calculator side whenever price changes
  // OR the user types into the "lead" side.
  useEffect(() => {
    if (!stats) return;
    if (lastEdited.current === "usd") {
      const u = parseFloat(usdInput);
      if (Number.isFinite(u) && stats.priceUsd > 0) {
        setVibeInput((u / stats.priceUsd).toFixed(2));
      } else {
        setVibeInput("");
      }
    } else {
      const v = parseFloat(vibeInput);
      if (Number.isFinite(v)) {
        setUsdInput((v * stats.priceUsd).toFixed(2));
      } else {
        setUsdInput("");
      }
    }
    // Intentionally only re-run when price changes or active input value
    // changes — never when the OTHER side changes (would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stats?.priceUsd,
    lastEdited.current === "usd" ? usdInput : vibeInput,
  ]);

  const change = stats?.priceChange24h ?? null;
  const up = (change ?? 0) >= 0;
  const cap = stats?.marketCapUsd ?? stats?.fdvUsd ?? null;
  const usingFdv = stats?.marketCapUsd == null && stats?.fdvUsd != null;

  // 1M-VIBE benchmark stat — that fun reference number from the brief.
  const millionVibeUsd = useMemo(() => {
    if (!stats) return null;
    return stats.priceUsd * 1_000_000;
  }, [stats]);

  return (
    <div className="glass-panel rounded-2xl border border-primary/30 p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins className="w-4 h-4 text-primary" />
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
            $VIBE · Live
          </p>
          {/* Tiny pulse dot so it feels alive. Re-keys on every refresh
              so the CSS animation restarts and you see the heartbeat. */}
          <span
            key={pulse}
            className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"
            style={{
              boxShadow: "0 0 8px hsl(150 80% 60% / 0.8)",
              animation: "vibeHeartbeat 1.6s ease-out 1",
            }}
          />
        </div>
        <a
          href={`https://www.geckoterminal.com/${VIBE_NETWORK}/pools/${VIBE_POOL_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          title="Open the canonical $VIBE pool on GeckoTerminal"
        >
          <span>chart</span>
          <span aria-hidden>↗</span>
        </a>
      </div>

      {/* Market cap is the headline number — it's the figure the
          community cares about. Price-per-token + the rest become
          supporting stats below. */}
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <p
            key={`cap-${pulse}`}
            className="font-heading text-3xl md:text-4xl font-bold tracking-tight text-foreground"
            style={{
              animation: "vibeFlash 0.5s ease-out 1",
            }}
          >
            {loading ? (
              <span className="opacity-50 inline-flex items-center gap-2 text-base">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading…
              </span>
            ) : error || !stats ? (
              <span className="text-base text-muted-foreground italic">
                Couldn't fetch live data
              </span>
            ) : (
              fmtUsd(cap, { compact: true })
            )}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            {usingFdv ? "Fully-diluted valuation" : "Market cap"}
          </p>
        </div>

        {stats && change != null && (
          <div
            className={`rounded-full px-2.5 py-1 text-xs font-semibold flex items-center gap-1.5 ${
              up
                ? "bg-emerald-400/15 text-emerald-300 border border-emerald-400/40"
                : "bg-rose-400/15 text-rose-300 border border-rose-400/40"
            }`}
          >
            {up ? (
              <TrendingUp className="w-3.5 h-3.5" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" />
            )}
            <span>
              {up ? "+" : ""}
              {change.toFixed(2)}% · 24h
            </span>
          </div>
        )}
      </div>

      {/* Stats grid — price + pool liquidity + 24h volume support
          the headline market cap. */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Per token"
          value={stats ? fmtUsd(stats.priceUsd) : "—"}
        />
        <Stat
          label="Liquidity"
          value={fmtUsd(stats?.liquidityUsd ?? null, { compact: true })}
          tooltip="USD value of both sides of the canonical $VIBE pool on Base"
        />
        <Stat
          label="24h volume"
          value={fmtUsd(stats?.volume24h ?? null, { compact: true })}
        />
      </div>

      {/* The fun "1M VIBE = $X" benchmark from the brief. */}
      {millionVibeUsd != null && (
        <div className="rounded-lg bg-primary/10 border border-primary/30 px-3 py-2 text-xs text-foreground/85">
          🪙 <span className="font-semibold">1M $VIBE</span> ≈{" "}
          <span className="font-semibold text-primary">{fmtUsd(millionVibeUsd, { compact: true })}</span>
        </div>
      )}

      {/* Calculator */}
      <div className="rounded-lg border border-border/60 bg-background/30 p-3 flex flex-col gap-2">
        <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground">
          Calculator
        </p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-widest text-muted-foreground">USD</span>
            <div className="flex items-center gap-1 rounded-md bg-background/60 border border-border/60 focus-within:border-primary/60 px-2 py-1.5">
              <span className="text-muted-foreground text-sm">$</span>
              <input
                inputMode="decimal"
                value={usdInput}
                onChange={(e) => {
                  lastEdited.current = "usd";
                  setUsdInput(e.target.value);
                }}
                placeholder="0"
                className="bg-transparent outline-none flex-1 text-sm font-mono"
              />
            </div>
          </label>
          <button
            type="button"
            onClick={() => {
              // Swap the two values + flip which side is "leading".
              // Lets the user click once to flip the calculator's
              // input focus without retyping.
              setUsdInput(vibeInput);
              setVibeInput(usdInput);
              lastEdited.current = lastEdited.current === "usd" ? "vibe" : "usd";
            }}
            title="Swap USD ↔ VIBE"
            aria-label="Swap input direction"
            className="text-muted-foreground hover:text-primary self-end pb-2 text-lg leading-none transition-colors"
          >
            ⇌
          </button>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-widest text-muted-foreground">$VIBE</span>
            <div className="flex items-center gap-1 rounded-md bg-background/60 border border-border/60 focus-within:border-primary/60 px-2 py-1.5">
              <input
                inputMode="decimal"
                value={vibeInput}
                onChange={(e) => {
                  lastEdited.current = "vibe";
                  setVibeInput(e.target.value);
                }}
                placeholder="0"
                className="bg-transparent outline-none flex-1 text-sm font-mono"
              />
            </div>
          </label>
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {[10, 50, 100, 500, 1000].map((amt) => (
            <button
              key={amt}
              onClick={() => {
                lastEdited.current = "usd";
                setUsdInput(String(amt));
              }}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 px-2 py-1 text-[10px] font-medium transition-colors"
            >
              ${amt}
            </button>
          ))}
        </div>
      </div>

      {stats && (
        <p className="text-[9px] text-muted-foreground/70 text-right">
          Updated {new Date(stats.fetchedAt).toLocaleTimeString()} ·
          source GeckoTerminal
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <div
      className="rounded-lg bg-background/40 border border-border/40 px-2.5 py-2"
      title={tooltip}
    >
      <p className="text-[9px] uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="font-heading text-sm font-semibold text-foreground mt-0.5 tabular-nums">
        {value}
      </p>
    </div>
  );
}
