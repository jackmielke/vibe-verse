# MediaPipe Tasks Vision, vendored

`@mediapipe/tasks-vision@0.10.14` (Apache-2.0, Google), copied from the npm
tarball, plus `pose_landmarker_lite.task` from
`storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/`.

Served from our own origin rather than a CDN so the boxing game (`/boxing`)
does not depend on a third party being up, and loaded with a runtime
`import()` only when somebody picks camera mode, so nobody else downloads it.
Only the SIMD wasm is kept; a browser without wasm SIMD falls back to the
motion tracker in `src/boxing/tracker.ts`.
