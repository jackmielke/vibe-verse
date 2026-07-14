/**
 * HeadlineTiles — the four numbers Jack checks first:
 * market cap, in-app supply, holders, treasury.
 *
 * Each tile declares its own provenance: a mint "live" pill when the
 * number came from a real source this session, an amber static marker
 * when it's the Jul-2026 snapshot from the notes.
 */
import { ExternalLink } from "lucide-react";
import {
  STATIC_MARKET_CAP_USD,
  TREASURY_ADDRESS,
  FALLBACK_HOLDERS,
} from "./data";
import type { EconomySnapshot } from "./useVibeDashboardData";
import { LiveMarker, StaticMarker, fmtUsd, fmtVibeAmount } from "./shared";

function Tile({
  label,
  value,
  sub,
  live,
  staticLabel,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  live: boolean;
  staticLabel?: string;
}) {
  return (
    <div className="glass-panel rounded-2xl border border-primary/30 p-4 flex flex-col gap-1.5 min-w-0">
      <p className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="font-heading text-2xl md:text-3xl font-bold tracking-tight text-foreground tabular-nums">
        {value}
      </p>
      {sub && <div className="text-[10px] text-muted-foreground leading-snug">{sub}</div>}
      {/* Provenance pill on its own row — the long "wire to live source"
          label never fights the tile header for width. */}
      <div className="mt-auto pt-1 self-start">
        {live ? <LiveMarker /> : <StaticMarker label={staticLabel} />}
      </div>
    </div>
  );
}

export function HeadlineTiles({
  economy,
  marketCap,
  treasuryBalance,
}: {
  economy: EconomySnapshot | null;
  marketCap: number | null;
  treasuryBalance: string | null;
}) {
  const holders = economy?.holders ?? FALLBACK_HOLDERS;
  const supply = economy?.totalSupply ?? holders.reduce((s, h) => s + h.balance, 0);
  const count = economy?.holdersCount ?? holders.length;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Tile
        label="Market cap (on-chain)"
        value={fmtUsd(marketCap ?? STATIC_MARKET_CAP_USD)}
        sub="FDV of the canonical Base pool"
        live={marketCap != null}
      />
      <Tile
        label="In-app supply"
        value={`${fmtVibeAmount(supply)} VIBE`}
        sub="Sum of all vibe_balances wallets"
        live={economy != null}
        staticLabel="snapshot · Jul 2026"
      />
      <Tile
        label="Holders (in-app)"
        value={String(count)}
        sub="Wallets in the simulated economy"
        live={economy != null}
        staticLabel="snapshot · Jul 2026"
      />
      <Tile
        label="Treasury $VIBE"
        value={treasuryBalance ?? "—"}
        sub={
          <a
            href={`https://basescan.org/address/${TREASURY_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono hover:text-primary transition-colors"
          >
            {TREASURY_ADDRESS.slice(0, 6)}…{TREASURY_ADDRESS.slice(-4)}
            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
          </a>
        }
        live={treasuryBalance != null}
      />
    </div>
  );
}
