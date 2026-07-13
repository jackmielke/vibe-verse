import type { Business, BusinessCategory, DuesStatus, EngagementEvent, DuesRecord } from "./types";

// Compact seed: [name, category, memberSince (0 = non-member), duesStatus,
// locallyOwned, janeLocalOwnership/30, janeYearsInTown/25, janeLocalHiring/25, janeCommunity/20]
type Seed = [string, BusinessCategory, number, DuesStatus | "", 0 | 1, number, number, number, number];

const seeds: Seed[] = [
  ["CraftWork", "Services", 2022, "current", 1, 30, 12, 22, 20],
  ["Boulangerie du Plaza", "Bakery & Café", 2017, "current", 1, 30, 18, 23, 17],
  ["Willow & Vine Kitchen", "Restaurant", 2019, "current", 1, 28, 14, 24, 18],
  ["The Noble Fig", "Bakery & Café", 2021, "overdue", 1, 30, 10, 20, 15],
  ["Spoke & Vine Bicycles", "Retail", 2015, "current", 1, 30, 20, 21, 19],
  ["Madrona House Inn", "Hotel & Lodging", 2012, "current", 1, 26, 22, 20, 14],
  ["Foss Creek Lodge", "Hotel & Lodging", 2018, "lapsed", 0, 8, 15, 18, 6],
  ["Plaza Arms Hotel", "Hotel & Lodging", 0, "", 0, 5, 20, 15, 4],
  ["Dry Creek Cellars", "Winery", 2010, "current", 1, 27, 24, 19, 16],
  ["Bella Luna Estate", "Winery", 2016, "current", 1, 25, 16, 17, 12],
  ["Foggline Vineyards", "Winery", 0, "", 1, 30, 12, 18, 8],
  ["Old Vine Collective", "Winery", 2020, "overdue", 1, 24, 9, 16, 13],
  ["Meridian Tasting Room", "Tasting Room", 2019, "current", 1, 26, 11, 15, 11],
  ["Plaza Cru Tasting Lounge", "Tasting Room", 0, "", 1, 28, 7, 14, 6],
  ["Harmon Street Tasting Room", "Tasting Room", 2023, "current", 0, 10, 5, 12, 9],
  ["Copita del Norte", "Restaurant", 2014, "current", 1, 30, 19, 25, 16],
  ["Threadbare Farm Table", "Restaurant", 0, "", 1, 29, 8, 22, 12],
  ["Plaza Bistro", "Restaurant", 2011, "lapsed", 1, 27, 23, 20, 8],
  ["Levee Street Books", "Retail", 2013, "current", 1, 30, 21, 18, 20],
  ["Plaza Mercantile", "Retail", 0, "", 1, 28, 17, 16, 10],
  ["Gather Home & Garden", "Retail", 2021, "current", 1, 26, 9, 15, 13],
  ["Early Bird Farm", "Farm & Ranch", 2018, "current", 1, 30, 16, 24, 19],
  ["Dry Creek Peach Co.", "Farm & Ranch", 0, "", 1, 30, 25, 23, 15],
  ["Bellwether Flower Farm", "Farm & Ranch", 2024, "current", 1, 29, 6, 20, 14],
  ["Sonoma Cask & Cooperage", "Manufacturing", 0, "", 1, 28, 22, 25, 9],
  ["Healdsburg Metalworks", "Manufacturing", 0, "", 1, 30, 18, 24, 7],
  ["North Bay Bottling Co.", "Manufacturing", 0, "", 0, 9, 14, 21, 5],
  ["Russian River Woodcraft", "Manufacturing", 0, "", 1, 30, 20, 22, 11],
  ["Vine & Valley Accounting", "Services", 2016, "current", 1, 30, 15, 17, 12],
  ["Foss Creek Design Co.", "Services", 2023, "current", 1, 29, 4, 14, 10],
  ["Alexander Valley Yoga", "Wellness", 2020, "overdue", 1, 30, 10, 16, 15],
  ["Plaza Day Spa", "Wellness", 2015, "current", 1, 25, 18, 19, 9],
  ["The Corvid Theater", "Arts & Culture", 2009, "current", 1, 28, 25, 15, 20],
  ["Healdsburg Art Collective", "Arts & Culture", 0, "", 1, 30, 13, 12, 18],
  ["Fitch Mountain Coffee", "Bakery & Café", 0, "", 1, 29, 11, 21, 13],
  ["Grove Street Provisions", "Retail", 2022, "current", 1, 27, 6, 15, 11],
  ["Westside Wine Tours", "Services", 2019, "overdue", 1, 26, 12, 18, 8],
  ["Casa de Milagros", "Restaurant", 0, "", 1, 30, 21, 24, 14],
  ["Chalkboard Kitchen Supply", "Retail", 0, "", 1, 24, 8, 13, 7],
  ["Mill Street Auto Works", "Services", 2008, "current", 1, 30, 25, 22, 10],
  ["Riverbend Kayak Co.", "Services", 2024, "current", 1, 28, 3, 16, 12],
  ["Solstice Salt & Sauna", "Wellness", 0, "", 1, 27, 5, 14, 9],
  ["Alexander Valley Olive Co.", "Farm & Ranch", 2017, "current", 1, 29, 19, 21, 13],
  ["Vintage Rail Wine Bar", "Tasting Room", 2021, "lapsed", 1, 25, 8, 15, 7],
  ["Healdsburg Candle Works", "Manufacturing", 0, "", 1, 30, 9, 19, 12],
];

const streets = [
  "Healdsburg Ave", "Center St", "Plaza St", "Matheson St", "Dry Creek Rd",
  "Westside Rd", "Grove St", "Mill St", "Foss Creek Ct", "North St",
];

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18);

const buildEngagement = (i: number, isMember: boolean): EngagementEvent[] => {
  if (!isMember) {
    return [{ date: "May 2026", kind: "note", text: "Identified in city business-license dataset — never contacted" }];
  }
  const pool: EngagementEvent[] = [
    { date: "Jun 2026", kind: "event", text: "Attended Summer Mixer at Dry Creek Cellars" },
    { date: "Jun 2026", kind: "email", text: "Opened newsletter “What’s new on the Plaza”" },
    { date: "May 2026", kind: "event", text: "Joined Local Business AI Series at CraftWork" },
    { date: "Apr 2026", kind: "email", text: "Opened renewal reminder (clicked pay link)" },
    { date: "Mar 2026", kind: "renewal", text: "Renewed annual membership" },
    { date: "Feb 2026", kind: "event", text: "Attended ribbon cutting on Center St" },
  ];
  return pool.filter((_, idx) => (idx + i) % 3 !== 1).slice(0, 4);
};

const buildDues = (i: number, dues: DuesStatus | ""): DuesRecord[] => {
  if (!dues) return [];
  const amt = 45 + (i % 4) * 10;
  const rows: DuesRecord[] = [
    { period: "Jul 2026", amount: amt, status: dues === "current" ? "paid" : "overdue" },
    { period: "Jun 2026", amount: amt, status: dues === "lapsed" ? "overdue" : "paid" },
    { period: "May 2026", amount: amt, status: "paid" },
    { period: "Apr 2026", amount: amt, status: "paid" },
  ];
  return rows;
};

export const businesses: Business[] = seeds.map((s, i) => {
  const [name, category, since, dues, local, lo, yt, lh, cp] = s;
  const isMember = since > 0;
  return {
    id: `biz-${i}`,
    name,
    category,
    isMember,
    memberSince: isMember ? String(since) : null,
    duesStatus: dues === "" ? null : dues,
    locallyOwned: local === 1,
    jane: { localOwnership: lo, yearsInTown: yt, localHiring: lh, communityParticipation: cp },
    contact: {
      name: ["Alma Reyes", "Sam Whitfield", "June Park", "Marco Bellini", "Tess O'Hara", "Devon Clarke"][i % 6],
      email: `hello@${slug(name)}.com`,
      phone: `(707) 431-${String(1000 + i * 37).slice(0, 4)}`,
      address: `${120 + i * 11} ${streets[i % streets.length]}`,
    },
    engagement: buildEngagement(i, isMember),
    dues: buildDues(i, dues),
  };
});

export const categories: BusinessCategory[] = [
  "Winery", "Tasting Room", "Restaurant", "Bakery & Café", "Hotel & Lodging",
  "Retail", "Services", "Farm & Ranch", "Manufacturing", "Wellness", "Arts & Culture",
];

// ——— Real research numbers (Healdsburg business-license dataset) ———
export const stats = {
  licensedBusinesses: 1815,
  locallyOwned: 793,
  chamberMembers: 397,
  confirmedLocalMembers: 76,
  localPenetration: 9.6, // %
  manufacturingCount: 33,
  manufacturingPenetration: 0, // %
  monthlyDues: 8240,
  chamberMasterCost: 4000, // per year, "+"
};

// Mock 12-month member growth (Aug 2025 → Jul 2026)
export const memberGrowth = [
  { month: "Aug", members: 362 }, { month: "Sep", members: 365 },
  { month: "Oct", members: 369 }, { month: "Nov", members: 371 },
  { month: "Dec", members: 370 }, { month: "Jan", members: 376 },
  { month: "Feb", members: 381 }, { month: "Mar", members: 384 },
  { month: "Apr", members: 388 }, { month: "May", members: 391 },
  { month: "Jun", members: 394 }, { month: "Jul", members: 397 },
];
