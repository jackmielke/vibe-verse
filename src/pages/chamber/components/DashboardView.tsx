import { Factory, Sparkles, TrendingUp } from "lucide-react";
import { stats } from "../data/businesses";
import { money } from "../theme";
import { LocalPenetrationDonut, MemberGrowthChart } from "./DashboardCharts";
import { Rise, SectionHeading, StatTile } from "./shared";

export const DashboardView = () => (
  <div>
    <SectionHeading
      title="Good morning, Healdsburg"
      subtitle="A live picture of the Chamber and the town it serves — built from the city's actual business-license dataset."
    />

    {/* Headline stats — real research numbers */}
    <Rise className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatTile label="Licensed businesses" value="1,815" hint="Active licenses in Healdsburg" />
      <StatTile label="Locally owned" value="793" hint="43.7% of all licensed businesses" tone="green" />
      <StatTile label="Chamber members" value="~397" hint="Current member roster" />
      <StatTile label="Local penetration" value="9.6%" hint="Only ~76 confirmed local members" tone="wine" />
    </Rise>

    <div className="grid lg:grid-cols-5 gap-4 mt-4">
      {/* Growth line */}
      <Rise delay={0.06} className="lg:col-span-3">
        <div className="rounded-xl bg-card border border-border shadow-sm p-5 h-full">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" /> Member growth
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">Last 12 months · +35 net members</p>
            </div>
            <span className="ch-serif text-2xl font-semibold text-primary tabular-nums">397</span>
          </div>
          <MemberGrowthChart />
        </div>
      </Rise>

      {/* Donut */}
      <Rise delay={0.12} className="lg:col-span-2">
        <div className="rounded-xl bg-card border border-border shadow-sm p-5 h-full">
          <h3 className="font-semibold text-foreground">Locally-owned businesses reached</h3>
          <p className="text-xs text-muted-foreground mt-0.5 mb-4">The Chamber's biggest growth story is next door</p>
          <LocalPenetrationDonut />
        </div>
      </Rise>
    </div>

    <div className="grid md:grid-cols-3 gap-4 mt-4">
      {/* Opportunity callout */}
      <Rise delay={0.18}>
        <div className="rounded-xl border border-primary/25 bg-primary/[0.06] shadow-sm p-5 h-full">
          <div className="flex items-center gap-2 text-primary">
            <Factory className="h-4 w-4" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">Opportunity</p>
          </div>
          <p className="ch-serif mt-2 text-2xl font-semibold text-foreground">33 manufacturers, 0 members</p>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Healdsburg's 33 manufacturing businesses have <span className="font-semibold text-foreground">0% Chamber
            penetration</span> — coopers, metalworks, bottlers. An entirely unrepresented sector, one outreach
            campaign away.
          </p>
        </div>
      </Rise>

      {/* Dues revenue */}
      <Rise delay={0.24}>
        <div className="rounded-xl bg-card border border-border shadow-sm p-5 h-full">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Monthly dues revenue</p>
          <p className="ch-serif mt-2 text-3xl font-semibold text-foreground tabular-nums">{money(stats.monthlyDues)}</p>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Collected across monthly + annualized dues. Reaching just 25% of locally-owned businesses would more than
            double this.
          </p>
        </div>
      </Rise>

      {/* ChamberMaster comparison */}
      <Rise delay={0.3}>
        <div className="rounded-xl border border-accent/30 bg-accent/[0.06] shadow-sm p-5 h-full">
          <div className="flex items-center gap-2 text-accent">
            <Sparkles className="h-4 w-4" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">Why this exists</p>
          </div>
          <p className="ch-serif mt-2 text-2xl font-semibold text-foreground">$4,000+/yr for software nobody understands</p>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            That's what ChamberMaster costs today — for manual invoicing, a clunky directory, and zero intelligence.
            Chamber OS replaces it with something the whole staff actually enjoys using.
          </p>
        </div>
      </Rise>
    </div>
  </div>
);
