import type { Invoice } from "./types";

export const invoices: Invoice[] = [
  { id: "INV-2607", business: "CraftWork", kind: "Monthly dues", amount: 65, issued: "Jul 1", due: "Jul 15", status: "paid" },
  { id: "INV-2608", business: "Boulangerie du Plaza", kind: "Monthly dues", amount: 55, issued: "Jul 1", due: "Jul 15", status: "paid" },
  { id: "INV-2609", business: "Dry Creek Cellars", kind: "Annual dues", amount: 720, issued: "Jul 1", due: "Jul 31", status: "paid" },
  { id: "INV-2610", business: "The Noble Fig", kind: "Monthly dues", amount: 55, issued: "Jun 1", due: "Jun 15", status: "overdue" },
  { id: "INV-2611", business: "Madrona House Inn", kind: "Annual dues", amount: 940, issued: "Jul 1", due: "Jul 31", status: "sent" },
  { id: "INV-2612", business: "Old Vine Collective", kind: "Monthly dues", amount: 65, issued: "Jun 1", due: "Jun 15", status: "overdue" },
  { id: "INV-2613", business: "Spoke & Vine Bicycles", kind: "Monthly dues", amount: 45, issued: "Jul 1", due: "Jul 15", status: "paid" },
  { id: "INV-2614", business: "Levee Street Books", kind: "Monthly dues", amount: 45, issued: "Jul 1", due: "Jul 15", status: "paid" },
  { id: "INV-2615", business: "Alexander Valley Yoga", kind: "Monthly dues", amount: 45, issued: "Jun 1", due: "Jun 15", status: "overdue" },
  { id: "INV-2616", business: "Copita del Norte", kind: "Event sponsorship", amount: 350, issued: "Jul 6", due: "Jul 20", status: "sent" },
  { id: "INV-2617", business: "The Corvid Theater", kind: "Annual dues", amount: 480, issued: "Jul 1", due: "Jul 31", status: "sent" },
  { id: "INV-2618", business: "Westside Wine Tours", kind: "Monthly dues", amount: 55, issued: "Jun 1", due: "Jun 15", status: "overdue" },
  { id: "INV-2619", business: "Plaza Day Spa", kind: "Monthly dues", amount: 55, issued: "Jul 1", due: "Jul 15", status: "paid" },
  { id: "INV-2620", business: "Early Bird Farm", kind: "Monthly dues", amount: 45, issued: "Jul 1", due: "Jul 15", status: "paid" },
];

export const billingComparison = {
  automated: [
    "Invoices generated + emailed on the 1st, automatically",
    "Two gentle reminders, then a personal-tone nudge from the AI agent",
    "Payments reconcile themselves — no spreadsheet double-entry",
    "Lapsed members flagged with a suggested win-back note",
  ],
  chamberMaster: [
    "Staff manually batch-creates invoices each month",
    "Reminders sent by hand — overdue members slip through",
    "Payments re-keyed into a separate spreadsheet",
    "Renewals tracked in someone's head (until they leave)",
  ],
};
