# The Magician

A valley village in rural Japan that rebuilds itself as you talk to Vibey.

```
state.ts          WorldState, patches, and the derived rules (fireballsFizzle, lanternsOn…)
tools.ts          TOOL_DEFINITIONS for OpenAI + runTool(name, args, store) that executes them
spellbook.ts      plain words → the same tool calls, no model needed (tests, typed input)
prompt.ts         Vibey's script: a voice prompt, a backend prompt, and the greeting
voice/session.ts  WebRTC to OpenAI; engines `realtime` (gpt-realtime-2.1) and `live` (gpt-live-1)
world/            three.js: Magician.ts assembles noise/terrain/sky/props/weather/fireballs/vibey/player
```

Page: `src/pages/Magician.tsx`. Key: `supabase/functions/vibe-magician-voice`
(`OPENAI_API_KEY` as a Supabase secret). Frames from a script:
`node scripts/magician-shot.mjs "make it rain" "midnight"`.

Adding a spell: a case in `runTool`, an entry in `TOOL_DEFINITIONS`, a field on
`WorldState` if it needs one, and something in `world/Magician.ts#applyState`
that eases toward it. Then a line in `src/test/magicianTools.test.ts`.
