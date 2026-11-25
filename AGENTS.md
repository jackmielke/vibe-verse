# City flying mounts
- Keep flying-mount motion and aerial tag rules in pure TypeScript modules; City owns the single frame step and multiplayer reuses its existing pose broadcasts, so rendered riding and game state stay connected.
- Use `?net=local` for two City tabs in one browser context when Realtime is unavailable; this exercises the same pose receiver and sky-tag messages without credentials.
- Reuse `__cityDebug.mount(kind)`, `mountState()`, `mountPose(x,y,z)`, `skyTag(on)`, `skyState()`, `peerStates()`, `identity(name,character)`, and `snapshot()` for mount checks; these probes reach the live engine instead of a second module instance.
- Remote procedural pilots must receive the catalog character ID, and ghost name sprites must refresh from incoming identity; otherwise all handmade characters turn into the fallback robot and renames remain stale.
