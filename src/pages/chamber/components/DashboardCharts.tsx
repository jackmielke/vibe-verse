import {
  Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, CartesianGrid,
} from "recharts";
import { chart } from "../theme";
import { memberGrowth, stats } from "../data/businesses";

const tooltipStyle = {
  backgroundColor: "hsl(40 45% 99%)",
  border: "1px solid hsl(40 20% 84%)",
  borderRadius: 10,
  fontSize: 12,
  color: "hsl(150 28% 14%)",
  boxShadow: "0 4px 16px rgba(46, 62, 45, 0.10)",
} as const;

/** 12-month member growth — single series, so the title carries identity. */
export const MemberGrowthChart = () => (
  <div className="h-52 w-full">
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={memberGrowth} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={chart.grid} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="month" tickLine={false} axisLine={{ stroke: chart.grid }}
          tick={{ fill: chart.axis, fontSize: 11 }} interval={1}
        />
        <YAxis
          domain={[350, 405]} tickLine={false} axisLine={false}
          tick={{ fill: chart.axis, fontSize: 11 }} width={52}
        />
        <Tooltip
          contentStyle={tooltipStyle} cursor={{ stroke: chart.axis, strokeDasharray: "3 3" }}
          formatter={(v: number) => [`${v} members`, ""]} separator=""
        />
        <Line
          type="monotone" dataKey="members" stroke={chart.green} strokeWidth={2}
          dot={false} activeDot={{ r: 4, fill: chart.green, stroke: "#FAF7F2", strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  </div>
);

const donutData = [
  { name: "Chamber members", value: stats.confirmedLocalMembers, color: chart.green },
  { name: "Not yet members", value: stats.locallyOwned - stats.confirmedLocalMembers, color: chart.wine },
];

/** Locally-owned businesses: members vs not-yet — the whole pitch in one ring. */
export const LocalPenetrationDonut = () => (
  <div className="flex items-center gap-5">
    <div className="relative h-40 w-40 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={donutData} dataKey="value" nameKey="name"
            innerRadius={52} outerRadius={72} paddingAngle={2}
            strokeWidth={2} stroke="#FAF7F2" startAngle={90} endAngle={-270}
          >
            {donutData.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${v} businesses`, n]} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="ch-serif text-2xl font-semibold text-foreground leading-none">9.6%</span>
        <span className="text-[10px] text-muted-foreground mt-1">local reach</span>
      </div>
    </div>
    <ul className="space-y-2.5 text-sm">
      {donutData.map((d) => (
        <li key={d.name} className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
          <span className="text-muted-foreground">{d.name}</span>
          <span className="font-semibold tabular-nums text-foreground">{d.value}</span>
        </li>
      ))}
      <li className="text-xs text-muted-foreground pt-1 max-w-[180px]">
        of {stats.locallyOwned} locally-owned businesses in Healdsburg
      </li>
    </ul>
  </div>
);
