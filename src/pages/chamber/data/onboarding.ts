import type { ChatTurn } from "./types";

/** Scripted onboarding conversation — Solstice Ceramics Studio joins the Chamber. */
export const onboardingScript: ChatTurn[] = [
  {
    from: "agent",
    text: "Hi! I'm the Healdsburg Chamber's onboarding agent 🌿 I saw Solstice Ceramics Studio just got its business license on Center St — congrats! Want me to walk you through joining the Chamber? Takes about two minutes.",
  },
  {
    from: "business",
    text: "Oh nice, yes! We just opened last month. What does membership actually get us?",
  },
  {
    from: "agent",
    text: "For a studio your size: a listing in the local directory (12k visits/mo), invites to mixers and the Local Business AI Series at CraftWork, and we'll co-host your ribbon cutting. Dues would be $45/month — you're a 2-person locally-owned shop, so you qualify for the small-maker rate.",
  },
  {
    from: "business",
    text: "That's really reasonable. We're two co-owners, both live in town, and we're hiring a part-time kiln tech from the high school program.",
  },
  {
    from: "agent",
    text: "Love that — local owners, local hire, brand new to Center St. I've drafted your member record, scored your local roots, and prepared your first invoice. One click to confirm and you're officially in. Want me to also add your ribbon cutting to the July calendar?",
  },
  {
    from: "business",
    text: "Yes to all of it! 🎉",
  },
  {
    from: "agent",
    text: "Done! Welcome to the Healdsburg Chamber, Solstice Ceramics Studio. Your record, first invoice, and directory listing are below — and your ribbon cutting is on the books for July 24.",
  },
];

export const newMemberRecord = {
  name: "Solstice Ceramics Studio",
  category: "Arts & Culture",
  owners: "Maya Linden & Jules Okafor",
  address: "312 Center St",
  email: "hello@solsticeceramics.com",
  plan: "Small-maker · $45/mo",
  janeScore: 82,
  jane: { localOwnership: 30, yearsInTown: 4, localHiring: 25, communityParticipation: 23 },
  invoice: { id: "INV-2621", kind: "Monthly dues", amount: 45, due: "Aug 1, 2026" },
  listing: "Hand-thrown ceramics, open-studio Saturdays, and wheel classes for all ages — new on Center St.",
};
