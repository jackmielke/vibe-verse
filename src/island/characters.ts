// Free CC0 rigged characters with embedded animations.
// All from public CDNs; idle/walk/run clips will be auto-detected by name.

export type CharacterOption = {
  id: string;
  name: string;
  description: string;
  url: string;
  scale: number;
  yOffset: number;
  // Tuning for the in-card 3D preview camera (per model, since they vary in size).
  previewDistance: number;
  previewHeight: number;
  previewTarget: number; // y of lookAt target
  accent: string; // tailwind gradient classes for card backdrop
};

export const CHARACTERS: CharacterOption[] = [
  {
    id: "soldier",
    name: "Scout",
    description: "Field-ready and steady on her feet.",
    url: "https://threejs.org/examples/models/gltf/Soldier.glb",
    scale: 1.0,
    yOffset: 0,
    previewDistance: 2.6,
    previewHeight: 1.55,
    previewTarget: 1.3,
    accent: "from-emerald-500/30 to-teal-700/30",
  },
  {
    id: "xbot",
    name: "Astra",
    description: "Sleek explorer in a chrome suit.",
    url: "https://threejs.org/examples/models/gltf/Xbot.glb",
    scale: 1.0,
    yOffset: 0,
    previewDistance: 2.6,
    previewHeight: 1.55,
    previewTarget: 1.3,
    accent: "from-sky-400/30 to-indigo-700/30",
  },
  {
    id: "robot",
    name: "Unit-7",
    description: "A friendly walking robot.",
    url: "https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb",
    scale: 0.5,
    yOffset: 0,
    previewDistance: 3.2,
    previewHeight: 1.6,
    previewTarget: 1.3,
    accent: "from-orange-400/30 to-rose-600/30",
  },
  {
    id: "michelle",
    name: "Michelle",
    description: "Dancer with effortless rhythm.",
    url: "https://threejs.org/examples/models/gltf/Michelle.glb",
    scale: 1.0,
    yOffset: 0,
    previewDistance: 2.8,
    previewHeight: 1.55,
    previewTarget: 1.3,
    accent: "from-fuchsia-400/30 to-purple-700/30",
  },
  {
    id: "cesium",
    name: "Mariner",
    description: "Classic wanderer in a blue suit.",
    url: "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb",
    scale: 1.0,
    yOffset: 0,
    previewDistance: 2.6,
    previewHeight: 1.55,
    previewTarget: 1.3,
    accent: "from-cyan-400/30 to-blue-700/30",
  },
  {
    id: "fox",
    name: "Vulpa",
    description: "A nimble fox who knows the trails.",
    url: "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Fox/glTF-Binary/Fox.glb",
    scale: 0.012,
    yOffset: 0,
    previewDistance: 2.4,
    previewHeight: 1.0,
    previewTarget: 0.7,
    accent: "from-amber-400/30 to-orange-700/30",
  },
];
