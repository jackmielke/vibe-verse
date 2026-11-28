export interface WorldData {
  name: string;
  theme: {
    background: string; // Gradient for sky
    platformColor: string;
    accentColor: string;
  };
  platforms: Array<{ x: number; y: number; width: number; height: number }>;
  coins: Array<{ x: number; y: number; width: number; height: number; floatOffset: number }>;
  shields: Array<{ x: number; y: number; width: number; height: number; floatOffset: number }>;
  enemies: Array<{ x: number; y: number; width: number; height: number; velocityX: number; direction: number }>;
  goal: { x: number; y: number; width: number; height: number };
  playerStart: { x: number; y: number };
  decorations?: Array<{ x: number; y: number; width: number; height: number; type: 'pumpkin' | 'ghost' | 'bat' }>;
  secrets?: Array<{ x: number; y: number; width: number; height: number; floatOffset: number }>;
  boss?: { x: number; y: number; width: number; height: number; health: number };
}

export const WORLDS: WorldData[] = [
  // World 1: Sky Islands - Sky searching for a new home
  {
    name: "Sky Islands",
    theme: {
      background: "linear-gradient(to bottom, #87CEEB 0%, #E0F6FF 100%)",
      platformColor: "#90EE90",
      accentColor: "#FFD700",
    },
    playerStart: { x: 100, y: 100 },
    platforms: [
      { x: 0, y: 500, width: 400, height: 100 },
      { x: 450, y: 450, width: 200, height: 30 },
      { x: 700, y: 380, width: 180, height: 30 },
      { x: 950, y: 320, width: 200, height: 30 },
      { x: 1200, y: 400, width: 220, height: 30 },
      { x: 1500, y: 450, width: 200, height: 30 },
      { x: 1800, y: 380, width: 250, height: 30 },
      { x: 2100, y: 320, width: 200, height: 30 },
      { x: 2400, y: 400, width: 300, height: 100 },
    ],
    coins: [
      { x: 520, y: 400, width: 30, height: 30, floatOffset: 0 },
      { x: 770, y: 330, width: 30, height: 30, floatOffset: 1 },
      { x: 1020, y: 270, width: 30, height: 30, floatOffset: 2 },
      { x: 1270, y: 350, width: 30, height: 30, floatOffset: 0.5 },
      { x: 1570, y: 400, width: 30, height: 30, floatOffset: 1.5 },
      { x: 1900, y: 330, width: 30, height: 30, floatOffset: 2.5 },
      { x: 2170, y: 270, width: 30, height: 30, floatOffset: 0.8 },
    ],
    shields: [
      { x: 1300, y: 350, width: 35, height: 35, floatOffset: 3 },
    ],
    enemies: [
      { x: 750, y: 340, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 1550, y: 410, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 1850, y: 340, width: 40, height: 40, velocityX: 2, direction: -1 },
      { x: 1100, y: 370, width: 40, height: 40, velocityX: 2, direction: 1 },
    ],
    decorations: [
      { x: 300, y: 450, width: 50, height: 50, type: 'pumpkin' },
      { x: 900, y: 250, width: 45, height: 45, type: 'ghost' },
      { x: 1700, y: 320, width: 40, height: 40, type: 'bat' },
      { x: 2250, y: 350, width: 50, height: 50, type: 'pumpkin' },
    ],
    secrets: [
      { x: 650, y: 350, width: 45, height: 45, floatOffset: 4 },
    ],
    goal: { x: 2550, y: 320, width: 80, height: 80 },
  },

  // World 2: Cloud Castles - Majestic floating fortresses
  {
    name: "Cloud Castles",
    theme: {
      background: "linear-gradient(to bottom, #9B59B6 0%, #E8DAEF 100%)",
      platformColor: "#DAA520",
      accentColor: "#FF69B4",
    },
    playerStart: { x: 100, y: 100 },
    platforms: [
      { x: 0, y: 500, width: 300, height: 100 },
      { x: 400, y: 420, width: 150, height: 30 },
      { x: 600, y: 350, width: 120, height: 30 },
      { x: 800, y: 280, width: 150, height: 30 },
      { x: 1050, y: 220, width: 180, height: 30 },
      { x: 1300, y: 300, width: 150, height: 30 },
      { x: 1550, y: 380, width: 200, height: 30 },
      { x: 1850, y: 320, width: 150, height: 30 },
      { x: 2100, y: 250, width: 180, height: 30 },
      { x: 2350, y: 350, width: 200, height: 30 },
      { x: 2650, y: 420, width: 300, height: 100 },
    ],
    coins: [
      { x: 470, y: 370, width: 30, height: 30, floatOffset: 0 },
      { x: 670, y: 300, width: 30, height: 30, floatOffset: 1 },
      { x: 870, y: 230, width: 30, height: 30, floatOffset: 2 },
      { x: 1120, y: 170, width: 30, height: 30, floatOffset: 0.5 },
      { x: 1370, y: 250, width: 30, height: 30, floatOffset: 1.5 },
      { x: 1620, y: 330, width: 30, height: 30, floatOffset: 2.5 },
      { x: 1920, y: 270, width: 30, height: 30, floatOffset: 0.8 },
      { x: 2170, y: 200, width: 30, height: 30, floatOffset: 1.2 },
      { x: 2420, y: 300, width: 30, height: 30, floatOffset: 0.3 },
    ],
    shields: [
      { x: 1500, y: 340, width: 35, height: 35, floatOffset: 3.5 },
    ],
    enemies: [
      { x: 450, y: 380, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 700, y: 280, width: 40, height: 40, velocityX: 2.5, direction: 1 }, // Floating enemy
      { x: 850, y: 240, width: 40, height: 40, velocityX: 2, direction: -1 },
      { x: 1150, y: 180, width: 40, height: 40, velocityX: 2.5, direction: -1 }, // Floating enemy
      { x: 1350, y: 260, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 1600, y: 340, width: 40, height: 40, velocityX: 2, direction: -1 },
      { x: 1950, y: 280, width: 40, height: 40, velocityX: 2.5, direction: 1 }, // Floating enemy
      { x: 2150, y: 210, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 2450, y: 310, width: 40, height: 40, velocityX: 2, direction: -1 },
    ],
    decorations: [
      { x: 200, y: 440, width: 50, height: 50, type: 'pumpkin' },
      { x: 1000, y: 140, width: 45, height: 45, type: 'ghost' },
      { x: 1750, y: 260, width: 40, height: 40, type: 'bat' },
      { x: 2300, y: 280, width: 50, height: 50, type: 'pumpkin' },
    ],
    secrets: [
      { x: 1000, y: 250, width: 45, height: 45, floatOffset: 4.5 },
      { x: 2200, y: 180, width: 45, height: 45, floatOffset: 5 },
    ],
    goal: { x: 2750, y: 340, width: 80, height: 80 },
  },

  // World 3: Storm Realm - The final challenge
  {
    name: "Storm Realm",
    theme: {
      background: "linear-gradient(to bottom, #2C3E50 0%, #34495E 100%)",
      platformColor: "#5DADE2",
      accentColor: "#F39C12",
    },
    playerStart: { x: 100, y: 100 },
    platforms: [
      { x: 0, y: 500, width: 300, height: 100 },
      { x: 500, y: 450, width: 100, height: 30 },
      { x: 800, y: 400, width: 100, height: 30 },
      { x: 1100, y: 350, width: 100, height: 30 },
      { x: 1450, y: 300, width: 120, height: 30 },
      { x: 1750, y: 250, width: 100, height: 30 },
      { x: 2000, y: 350, width: 100, height: 30 },
      { x: 2300, y: 400, width: 150, height: 30 },
      { x: 2600, y: 450, width: 400, height: 100 },
    ],
    coins: [
      { x: 650, y: 400, width: 30, height: 30, floatOffset: 0 },
      { x: 950, y: 360, width: 30, height: 30, floatOffset: 1 },
      { x: 1250, y: 310, width: 30, height: 30, floatOffset: 2 },
      { x: 1600, y: 260, width: 30, height: 30, floatOffset: 0.5 },
      { x: 1875, y: 300, width: 30, height: 30, floatOffset: 1.5 },
      { x: 2150, y: 350, width: 30, height: 30, floatOffset: 2.5 },
      { x: 2450, y: 360, width: 30, height: 30, floatOffset: 0.8 },
    ],
    shields: [
      { x: 1450, y: 250, width: 35, height: 35, floatOffset: 3.5 },
    ],
    enemies: [
      { x: 550, y: 410, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 900, y: 350, width: 40, height: 40, velocityX: 2.5, direction: 1 }, // Floating enemy
      { x: 1150, y: 310, width: 40, height: 40, velocityX: 2, direction: -1 },
      { x: 1300, y: 250, width: 40, height: 40, velocityX: 2.5, direction: -1 }, // Floating enemy
      { x: 1500, y: 260, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 1850, y: 300, width: 40, height: 40, velocityX: 2.5, direction: 1 }, // Floating enemy
      { x: 2050, y: 310, width: 40, height: 40, velocityX: 2, direction: -1 },
      { x: 2350, y: 360, width: 40, height: 40, velocityX: 2, direction: 1 },
      { x: 650, y: 460, width: 40, height: 40, velocityX: 2.5, direction: -1 },
    ],
    decorations: [
      { x: 150, y: 450, width: 50, height: 50, type: 'pumpkin' },
      { x: 700, y: 280, width: 45, height: 45, type: 'ghost' },
      { x: 1650, y: 310, width: 40, height: 40, type: 'bat' },
      { x: 2500, y: 370, width: 50, height: 50, type: 'pumpkin' },
    ],
    secrets: [
      { x: 1100, y: 280, width: 45, height: 45, floatOffset: 3.8 },
    ],
    goal: { x: 2850, y: 370, width: 80, height: 80 },
  },

  // World 4: Void Peaks - The ultimate test
  {
    name: "Void Peaks",
    theme: {
      background: "linear-gradient(to bottom, #0F0F0F 0%, #1A0B2E 100%)",
      platformColor: "#8B00FF",
      accentColor: "#00FFFF",
    },
    playerStart: { x: 100, y: 100 },
    platforms: [
      { x: 0, y: 500, width: 250, height: 100 },
      { x: 450, y: 480, width: 80, height: 20 },
      { x: 700, y: 460, width: 80, height: 20 },
      { x: 950, y: 420, width: 80, height: 20 },
      { x: 1200, y: 360, width: 80, height: 20 },
      { x: 1500, y: 300, width: 90, height: 20 },
      { x: 1850, y: 240, width: 80, height: 20 },
      { x: 2100, y: 320, width: 80, height: 20 },
      { x: 2400, y: 380, width: 80, height: 20 },
      { x: 2700, y: 440, width: 100, height: 20 },
      { x: 3050, y: 380, width: 80, height: 20 },
      { x: 3350, y: 320, width: 80, height: 20 },
      { x: 3650, y: 450, width: 350, height: 100 },
    ],
    coins: [
      { x: 500, y: 430, width: 30, height: 30, floatOffset: 0 },
      { x: 750, y: 410, width: 30, height: 30, floatOffset: 1 },
      { x: 1000, y: 370, width: 30, height: 30, floatOffset: 2 },
      { x: 1250, y: 310, width: 30, height: 30, floatOffset: 0.5 },
      { x: 1550, y: 250, width: 30, height: 30, floatOffset: 1.5 },
      { x: 1900, y: 190, width: 30, height: 30, floatOffset: 2.5 },
      { x: 2150, y: 270, width: 30, height: 30, floatOffset: 0.8 },
      { x: 2450, y: 330, width: 30, height: 30, floatOffset: 1.2 },
      { x: 2750, y: 390, width: 30, height: 30, floatOffset: 0.3 },
      { x: 3100, y: 330, width: 30, height: 30, floatOffset: 1.8 },
      { x: 3400, y: 270, width: 30, height: 30, floatOffset: 0.6 },
    ],
    shields: [
      { x: 2000, y: 280, width: 35, height: 35, floatOffset: 5.5 },
    ],
    enemies: [
      { x: 500, y: 440, width: 40, height: 40, velocityX: 2.5, direction: 1 },
      { x: 1000, y: 380, width: 40, height: 40, velocityX: 2.5, direction: -1 },
      { x: 1550, y: 260, width: 40, height: 40, velocityX: 2.5, direction: 1 },
      { x: 1900, y: 200, width: 40, height: 40, velocityX: 2.5, direction: -1 },
      { x: 2450, y: 340, width: 40, height: 40, velocityX: 2.5, direction: 1 },
      { x: 2750, y: 400, width: 40, height: 40, velocityX: 2.5, direction: -1 },
      { x: 3100, y: 340, width: 40, height: 40, velocityX: 2.5, direction: 1 },
      { x: 3400, y: 280, width: 40, height: 40, velocityX: 2.5, direction: -1 },
      { x: 800, y: 420, width: 40, height: 40, velocityX: 2.5, direction: 1 },
      { x: 2200, y: 280, width: 40, height: 40, velocityX: 2.5, direction: -1 },
    ],
    decorations: [
      { x: 150, y: 450, width: 50, height: 50, type: 'pumpkin' },
      { x: 1200, y: 300, width: 45, height: 45, type: 'ghost' },
      { x: 2200, y: 260, width: 40, height: 40, type: 'bat' },
      { x: 3000, y: 330, width: 50, height: 50, type: 'pumpkin' },
      { x: 3500, y: 270, width: 45, height: 45, type: 'ghost' },
    ],
    secrets: [
      { x: 1400, y: 270, width: 45, height: 45, floatOffset: 6 },
      { x: 2900, y: 350, width: 45, height: 45, floatOffset: 6.5 },
    ],
    goal: { x: 3850, y: 370, width: 80, height: 80 },
  },

  // World 5: Boss Battle - Skeleton King
  {
    name: "Skeleton King Battle",
    theme: {
      background: "linear-gradient(to bottom, #1a0000 0%, #330000 100%)",
      platformColor: "#4a0000",
      accentColor: "#ff0000",
    },
    playerStart: { x: 100, y: 100 },
    platforms: [
      { x: 0, y: 500, width: 1200, height: 100 },
      { x: 200, y: 380, width: 150, height: 20 },
      { x: 850, y: 380, width: 150, height: 20 },
      { x: 500, y: 280, width: 200, height: 20 },
    ],
    coins: [
      { x: 250, y: 330, width: 30, height: 30, floatOffset: 0 },
      { x: 550, y: 230, width: 30, height: 30, floatOffset: 1 },
      { x: 900, y: 330, width: 30, height: 30, floatOffset: 2 },
    ],
    shields: [
      { x: 600, y: 230, width: 35, height: 35, floatOffset: 3 },
    ],
    enemies: [],
    decorations: [
      { x: 50, y: 450, width: 50, height: 50, type: 'pumpkin' },
      { x: 1100, y: 450, width: 50, height: 50, type: 'pumpkin' },
    ],
    secrets: [],
    boss: { x: 600, y: 200, width: 120, height: 160, health: 10 },
    goal: { x: 550, y: 420, width: 80, height: 80 },
  },
];
