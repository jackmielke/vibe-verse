import { AnimatePresence, motion } from "framer-motion";
import { CalendarCheck, Mail, MapPin, Phone, RefreshCw, StickyNote, User, X } from "lucide-react";
import type { Business } from "../data/types";
import { janeScore } from "../data/types";
import { janeColor, money } from "../theme";
import { JaneMeter, StatusPill } from "./shared";

const kindIcon = {
  event: CalendarCheck, email: Mail, renewal: RefreshCw, note: StickyNote,
} as const;

const janeRows = (b: Business) => [
  { label: "Local ownership", value: b.jane.localOwnership, max: 30 },
  { label: "Years in town", value: b.jane.yearsInTown, max: 25 },
  { label: "Local hiring", value: b.jane.localHiring, max: 25 },
  { label: "Community participation", value: b.jane.communityParticipation, max: 20 },
];

export const MemberDetail = ({ business, onClose }: { business: Business | null; onClose: () => void }) => (
  <AnimatePresence>
    {business && (
      <>
        <motion.button
          aria-label="Close details"
          className="fixed inset-0 z-40 bg-foreground/25 backdrop-blur-[2px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
        />
        <motion.aside
          className="fixed right-0 top-0 z-50 h-full w-full max-w-md bg-card border-l border-border shadow-2xl overflow-y-auto"
          initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 30, stiffness: 300 }}
        >
          <div className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{business.category}</p>
                <h2 className="ch-serif text-2xl font-semibold text-foreground mt-1">{business.name}</h2>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {business.isMember
                    ? <span className="text-xs text-muted-foreground">Member since {business.memberSince}</span>
                    : <span className="text-xs font-semibold text-accent">Not yet a member</span>}
                  {business.duesStatus && <StatusPill kind={business.duesStatus} />}
                  {business.locallyOwned && (
                    <span className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-[11px] font-semibold">Locally owned</span>
                  )}
                </div>
              </div>
              <button onClick={onClose} className="rounded-full p-2 hover:bg-secondary transition-colors" aria-label="Close">
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>

            {/* Contact */}
            <div className="mt-6 rounded-xl bg-secondary/60 p-4 space-y-2 text-sm">
              {[
                { Icon: User, text: business.contact.name },
                { Icon: Mail, text: business.contact.email },
                { Icon: Phone, text: business.contact.phone },
                { Icon: MapPin, text: `${business.contact.address}, Healdsburg, CA` },
              ].map(({ Icon, text }) => (
                <p key={text} className="flex items-center gap-2.5 text-foreground/90">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> {text}
                </p>
              ))}
            </div>

            {/* Jane Score breakdown */}
            <div className="mt-6">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-foreground">Jane Score</h3>
                <JaneMeter score={janeScore(business.jane)} />
              </div>
              <p className="text-xs text-muted-foreground mt-1 mb-3">
                Authentic-local-business score, named after Jane Jacobs.
              </p>
              <div className="space-y-2.5">
                {janeRows(business).map((r) => (
                  <div key={r.label}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="tabular-nums font-medium text-foreground">{r.value}/{r.max}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(r.value / r.max) * 100}%`,
                          backgroundColor: janeColor(janeScore(business.jane)),
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Dues history */}
            {business.dues.length > 0 && (
              <div className="mt-6">
                <h3 className="font-semibold text-foreground mb-2">Dues history</h3>
                <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                  {business.dues.map((d) => (
                    <div key={d.period} className="flex items-center justify-between px-4 py-2.5 text-sm bg-card">
                      <span className="text-muted-foreground">{d.period}</span>
                      <span className="tabular-nums font-medium text-foreground">{money(d.amount)}</span>
                      <StatusPill kind={d.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Engagement timeline */}
            <div className="mt-6 pb-4">
              <h3 className="font-semibold text-foreground mb-3">Engagement</h3>
              <ol className="relative border-l border-border ml-1.5 space-y-4">
                {business.engagement.map((e, i) => {
                  const Icon = kindIcon[e.kind];
                  return (
                    <li key={i} className="ml-5">
                      <span className="absolute -left-[9px] mt-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-secondary border border-border">
                        <Icon className="h-2.5 w-2.5 text-muted-foreground" />
                      </span>
                      <p className="text-sm text-foreground/90">{e.text}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{e.date}</p>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </motion.aside>
      </>
    )}
  </AnimatePresence>
);
