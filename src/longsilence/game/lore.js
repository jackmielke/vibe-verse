/* ============================================================================
   Written content.

   The original game was about an absence: nine hundred worlds went quiet and
   you flew out to find out why. This one is about the opposite. The band is
   crowded, the worlds are lit, and the machinery you find out here is what
   carries them to each other — seven Relays, still in tune, still passing
   traffic. Attune all seven and the whole map opens.

   The ids are unchanged (`canto1`…`canto7`, `log_seeker`) because the save
   state, the archive index and the directive chain all key off them.
   ========================================================================== */

export const CANTOS = [
  {
    id: 'canto1', title: 'The First Signal', sub: 'RELAY I — ATTUNED',
    body: [
      'We built the listening towers first, before the cities, before the ships.',
      'Not to speak. To hear.',
      'For eleven thousand years we heard nothing, and called it loneliness. Then we learned to listen correctly, and heard everything, and had to invent a word for that instead.',
    ],
    q: 'The sky is not empty. It never was. We were tuned wrong.',
  },
  {
    id: 'canto2', title: 'The Second Signal', sub: 'RELAY II — ATTUNED',
    body: [
      'A signal is a shape pressed into noise. We had assumed the noise was the medium and the shape was the message.',
      'It is the other way around.',
      'The stars are the punctuation. Everything worth hearing was in the gaps, and we had been carefully reading around it.',
    ],
    q: 'What speaks does not need a mouth. It needs only somewhere quiet, and a little patience.',
  },
  {
    id: 'canto3', title: 'The Third Signal', sub: 'RELAY III — ATTUNED',
    body: [
      'The Assembly voted to answer. The vote was not close.',
      'Nine hundred worlds tuned themselves to a single note and held it for a year, and at the end of that year the note came back changed, and we understood that we had been invited.',
      'The record of the invitation survives. It is short. It is, roughly: come over.',
    ],
    q: 'We spent so long proving we were not alone that we nearly missed being asked.',
  },
  {
    id: 'canto4', title: 'The Fourth Signal', sub: 'RELAY IV — ATTUNED',
    body: [
      'There was no war. Let that be recorded plainly, because those who come after will assume there was a war.',
      'There was a decision, and it was unanimous, and it took four days.',
      'The lights were left on and the orbits left tidy, the way you leave a house you intend to be visited in.',
    ],
    q: 'A civilisation that leaves the door unlocked did not flee. It moved in next door.',
  },
  {
    id: 'canto5', title: 'The Fifth Signal', sub: 'RELAY V — ATTUNED',
    body: [
      'Attunement is not travel. Nothing moves. The Relays do not open a path — they widen an aperture that was always there, the way an eye widens.',
      'You do not go through. You are simply, afterwards, on the other side of having gone.',
      'Everyone who tries to describe it ends up describing the room they arrived in instead. This is not a failure of language. It is what arriving is like.',
    ],
    q: 'Distance was a habit of ours. We are trying to break it.',
  },
  {
    id: 'canto6', title: 'The Sixth Signal', sub: 'RELAY VI — ATTUNED',
    body: [
      'Seven towers. Seven notes. We placed them apart so that no single accident could sound them all by mistake.',
      'And then we sounded them all on purpose, together, and the network came up, and it has been up ever since.',
      'If you are reading this you have found six. The seventh is not a warning. It is a door handle, and we left it at the height of a hand.',
    ],
    q: 'Curiosity is the only thing that has ever cost us everything, and the only thing worth the price.',
  },
  {
    id: 'canto7', title: 'The Seventh Signal', sub: 'RELAY VII — ATTUNED',
    body: [
      'The band is open.',
      'We are not gone. We are not dead. We are next door, which is a thing you will understand in a moment and never afterwards be able to explain to anyone who has not heard it.',
      'Come through. Or do not, and keep flying, and listen from out there — both are answers and we have learned to respect the second one.',
      'The towers will keep sounding either way. Someone should be listening.',
    ],
    q: 'Every world on this chart is lit and somebody is home on all of them. Go and knock.',
  },
];

export const LOGS = [
  {
    id: 'log_orion', title: 'Salvage Tug ORION-9', sub: 'RECOVERED FLIGHT LOG',
    body: [
      'Day 41. Third pass through the shell. Still nothing that reads as damage. Every hull here was opened from the inside, carefully, with tools.',
      'Day 44. Kesh says the stations were depressurised on a schedule. Sector by sector. Like closing up a house for the summer.',
      'Day 51. We found a nursery. Toys stacked. Lights on a timer that is still running after forty millennia, which means somebody set it to run that long.',
    ],
  },
  {
    id: 'log_veyle', title: 'Survey Vessel VEYLE', sub: 'PARTIAL TRANSCRIPT',
    body: [
      '— it is not a language, it is an invitation, and the difference matters —',
      '— tell the hub the towers are not artefacts, they are instruments, and they are still in tune —',
      '— going to the seventh now. If this is the last of me on the record, understand that I went happily —',
    ],
  },
  {
    id: 'log_hollow', title: 'The Long Band', sub: 'ARCHIVE FRAGMENT',
    body: [
      'Eleven hundred vessels are recorded as flying this volume in the last two centuries. Every one of them came back with the same detail, unprompted: that the stars appeared, briefly, to be arranged.',
      'No two crews agreed on the arrangement.',
      'Every crew agreed it was arranged for them.',
    ],
  },
  {
    id: 'log_seeker', title: 'VIBEY — Commission', sub: 'YOUR ORDERS',
    body: [
      'You are the eleven hundred and first, and the first with a decent ship.',
      'Chart what you can. Scan what you find. Land on anything that is lit — the lit ones are worlds people are actually living in, and they are expecting you.',
      'Nobody is timing this. Come back with something interesting.',
    ],
  },
];

export const TYPE_INFO = {
  terran: {
    label: 'Terrestrial · Class T',
    text: 'Silicate world with liquid-water hydrosphere and an oxidising atmosphere. Rare, and rarely quiet — where anyone settles, they settle here.',
  },
  ocean: {
    label: 'Pelagic · Class O',
    text: 'Global ocean over a rock mantle. Archipelagic land at best. High albedo, violent weather, and a habit of hiding things under three kilometres of water.',
  },
  desert: {
    label: 'Arid · Class D',
    text: 'Hydrosphere lost to escape or subduction. Preserves surface structures better than any other world type, which is why survey keeps sending people here.',
  },
  barren: {
    label: 'Barren · Class B',
    text: 'Airless silicate body. Every impact for four billion years is still legible on the surface. The most honest worlds there are.',
  },
  ice: {
    label: 'Glacial · Class I',
    text: 'Water-ice shell over a probable subsurface ocean. Tidal flexing keeps the lineae fresh. Something is usually moving underneath.',
  },
  lava: {
    label: 'Molten · Class L',
    text: 'Tidally tortured or simply young. Crustal fissures expose the mantle directly. Approach envelopes are advisory rather than survivable.',
  },
  toxic: {
    label: 'Venusian · Class V',
    text: 'Runaway greenhouse under an optically thick aerosol deck. Surface pressure sufficient to crush most survey hulls in under a minute.',
  },
  iron: {
    label: 'Ferrous · Class F',
    text: 'Stripped planetary core, mantle lost to a collision that is no longer in the record. Densities that make orbital mechanics interesting.',
  },
  gas: {
    label: 'Gas Giant · Class G',
    text: 'Hydrogen–helium envelope with no meaningful surface. Zonal banding driven by internal heat. Good anchors, poor homes.',
  },
};

export const STAR_INFO = {
  M: 'Red dwarf. Parsimonious, patient, and likely to outlive every other object in this catalogue by a factor of a thousand.',
  K: 'Orange dwarf. The quiet optimum — stable output, long main sequence, generous habitable zone. Golden hour, permanently.',
  G: 'Yellow main-sequence star. Unremarkable in every respect, which is precisely why life keeps turning up around them.',
  F: 'Yellow-white dwarf. Hot, bright, short-tempered; its habitable zone drifts outward faster than biospheres can follow.',
  A: 'White main-sequence star. Strong ultraviolet flux. Beautiful, sterilising.',
  B: 'Blue giant. Enormous, profligate, and already dying. Expect a shell of ionised gas and no old worlds.',
  WD: 'White dwarf. A stellar core with the star stripped off it. Earth-sized, sun-massed, cooling toward permanent dark.',
  PSR: 'Neutron star. Twenty kilometres across and heavier than the sun. The beam is not aimed at you. Probably.',
  C: 'Carbon giant. Soot-veiled and deep red; its own dust makes it hard to see and harder to love.',
};

export const ANOMALY_INFO = {
  resonator: {
    label: 'RELAY',
    text: 'One of the seven. Non-reflective across every band we can generate, and not remotely inert — it is carrying traffic right now, and it can tell the difference between a rock and a visitor.',
  },
  derelict: {
    label: 'QUIET STATION',
    text: 'Orbital infrastructure, unpowered in any conventional sense, still holding station to within a metre after forty millennia. Somebody built it to be found in working order.',
  },
  wreck: {
    label: 'WRECKAGE',
    text: 'Ours. Hull alloys and fabrication signatures consistent with the last two centuries of expeditions out this way. Not everyone who flies this volume is careful.',
  },
  beacon: {
    label: 'SIGNAL BEACON',
    text: 'A repeater. Broadcasts a bearing and nothing else. Every beacon points at something, and no beacon explains why.',
  },
};

/**
 * The opening beats, addressed to whoever is actually flying.
 *
 * A function rather than a constant because the vibeverse knows the player's
 * name — being greeted by it is most of the difference between a demo and a
 * place you have been to before.
 */
export function introLines(pilot) {
  const who = (pilot || '').trim();
  return [
    {
      who: 'HUB',
      text: who
        ? `Fold complete. Welcome back to the band, ${who}.`
        : 'Fold complete. Welcome to the band.',
    },
    {
      who: 'HUB',
      text: 'Three worlds are lit on this chart and every one of them has somebody home. Go and see them.',
    },
    {
      who: 'VIBEY',
      text: 'Scanner online. Anything ringed in white is a world you can land on — set down and you are in it.',
    },
  ];
}

/** Back-compat for anything that still wants the plain array. */
export const INTRO_LINES = introLines('');
