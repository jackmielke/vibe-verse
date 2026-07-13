export type DuesStatus = "current" | "overdue" | "lapsed";

export type BusinessCategory =
  | "Winery"
  | "Tasting Room"
  | "Restaurant"
  | "Bakery & Café"
  | "Hotel & Lodging"
  | "Retail"
  | "Services"
  | "Farm & Ranch"
  | "Manufacturing"
  | "Wellness"
  | "Arts & Culture";

export interface JaneBreakdown {
  localOwnership: number; // 0-30
  yearsInTown: number; // 0-25
  localHiring: number; // 0-25
  communityParticipation: number; // 0-20
}

export interface EngagementEvent {
  date: string;
  kind: "event" | "email" | "renewal" | "note";
  text: string;
}

export interface DuesRecord {
  period: string;
  amount: number;
  status: "paid" | "sent" | "overdue";
}

export interface Business {
  id: string;
  name: string;
  category: BusinessCategory;
  isMember: boolean;
  memberSince: string | null; // year, e.g. "2019"
  duesStatus: DuesStatus | null;
  locallyOwned: boolean;
  jane: JaneBreakdown;
  contact: { name: string; email: string; phone: string; address: string };
  engagement: EngagementEvent[];
  dues: DuesRecord[];
}

export interface Invoice {
  id: string;
  business: string;
  kind: "Monthly dues" | "Annual dues" | "Event sponsorship";
  amount: number;
  issued: string;
  due: string;
  status: "paid" | "sent" | "overdue";
}

export interface ChamberEvent {
  id: string;
  title: string;
  date: string; // ISO yyyy-mm-dd
  time: string;
  venue: string;
  registered: number;
  capacity: number;
  ticketPrice: number | null;
  blurb: string;
  registrants: string[];
}

export interface ChatTurn {
  from: "agent" | "business";
  text: string;
}

export const janeScore = (j: JaneBreakdown): number =>
  j.localOwnership + j.yearsInTown + j.localHiring + j.communityParticipation;
