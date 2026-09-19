# Where the models came from

Everything in this folder is CC0 or was generated for this project. None of it
requires attribution — this file exists because the people who made it deserve
naming anyway, and because "is this safe to ship?" should be answerable without
a git archaeology session.

| What | Who | Licence |
|---|---|---|
| `characters/` — ~47 of them (Casual, Chef, Knight, Ninja, Wizard, Witch, Zombie, Cow, Pug…) | [Quaternius](https://quaternius.com/), *Ultimate Animated Character Pack* | CC0 |
| `characters/Pirate_*` — the named pirates (Anne, Barbarossa, Henry, Mako, Sharky, the skeletons, the tentacle) | [Kay Lousberg](https://kaylousberg.com/game-assets), *KayKit Pirate Kit* | CC0 |
| `characters/Mage.glb` — the Magician's wizard body (Spellcast, Cheer, Idle, Walking, ninety clips) | [Kay Lousberg](https://kaylousberg.com/game-assets), *KayKit Adventurers Character Pack 1.0* | CC0 |
| `kits/pirate/`, `kits/crops/` | Kay Lousberg / Quaternius | CC0 |
| `nature/` | [Quaternius](https://quaternius.com/), *Simple Nature Pack* | CC0 |
| `robot-expressive.glb` (Vibey), `../../public/models/vibey.glb` | Tomás Laulhé, modified by Don McCurdy — the three.js example robot | CC0 |
| `floating-island.glb`, `floating-astronaut.glb`, `rocky.glb`, `pixel-touch.glb`, `iridescent-arc.glb`, `nimbus-vtol.glb` | Generated with [Meshy](https://www.meshy.ai/) for this project | ours |

**One thing to be careful about.** `src/island/characters.ts` loads
`Michelle.glb` from `threejs.org` over the network. That model is Mixamo-derived,
and Adobe's terms permit *using* it but not redistributing the file — so
hotlinking is fine and **copying it into this folder would not be.** If that
character ever needs to work offline, replace it rather than vendor it.

## Everything here has been optimised

`node scripts/glb-optimize.mjs --write` ran over this folder: WebP textures
capped at 1024, meshes welded, decimated (static props only) and quantized with
`KHR_mesh_quantization`. 254 MB → 70 MB.

Do not re-add a raw export without running it through the same pass. The
originals were Meshy exports at full density — `floating-island.glb` was 38.7 MB
and **1,049,034 triangles** for a prop that renders 300 px wide behind a menu.

`scripts/glb-verify.mjs` is the safety net: it diffs every model against a git
ref and fails if an animation clip, channel, skin, mesh or morph target went
missing. Run it after any bulk asset change.
