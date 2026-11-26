# What's New

The player-facing changelog at `/whats-new`, also reachable from the ✨ New chip
in the top bar, the WHAT'S NEW box on the front page and the ✨ New button in
Vibe Island's world controls.

- **By hand:** add an entry to the top of `ENTRIES` in `entries.ts`.
- **Build mode:** automatic. After a build passes, the workflow writes
  `auto/<date>-<build id>.json` from the build's commit message and commits it
  with the change, so undoing the build removes its entry too. One file per
  build means concurrent builds never conflict.

An `auto/*.json` file looks like:

```json
{ "date": "2026-11-26", "title": "Added a ride-on lawnmower", "body": "...", "world": "Vibe Island", "route": "/city?spawn=island" }
```

Write for players: what they can do now and where. Plain sentences, no em dashes.
