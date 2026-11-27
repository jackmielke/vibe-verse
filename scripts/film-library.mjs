#!/usr/bin/env node
/**
 * film-library — gather every filmed card clip into one shareable folder:
 * the MP4, a GIF of it, and an index.html gallery that plays them all.
 *
 *   node scripts/film-library.mjs /mnt/project-files/card-previews
 *
 * The MP4s in `src/assets/worlds/` (from `world-film.mjs`) are what the cards
 * load. GIFs are about five times heavier for the same picture, so they are
 * made here for pasting into chats and posts, never shipped to the site.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "film-library");
const src = resolve("src/assets/worlds");
mkdirSync(out, { recursive: true });

const clips = readdirSync(src).filter((f) => f.endsWith(".mp4")).sort();
const rows = [];
for (const f of clips) {
  const key = f.replace(/\.mp4$/, "");
  copyFileSync(join(src, f), join(out, f));
  const gif = join(out, `${key}.gif`);
  const r = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", join(src, f),
    "-vf", "fps=15,scale=400:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    "-loop", "0", gif,
  ], { stdio: "inherit" });
  const kb = (p) => Math.round(statSync(p).size / 1024);
  rows.push({ key, mp4: kb(join(out, f)), gif: r.status === 0 ? kb(gif) : null });
  console.log(`${key.padEnd(14)} mp4 ${kb(join(out, f))} KB   gif ${r.status === 0 ? kb(gif) + " KB" : "failed"}`);
}

const cards = rows
  .map(
    (r) => `<figure><video src="${r.key}.mp4" autoplay muted loop playsinline></video>
<figcaption><b>${r.key}</b> <a href="${r.key}.mp4" download>MP4 ${r.mp4} KB</a>${r.gif ? ` <a href="${r.key}.gif" download>GIF ${r.gif} KB</a>` : ""}</figcaption></figure>`,
  )
  .join("\n");
writeFileSync(
  join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vibe Verse clips</title>
<style>body{margin:0;padding:16px;background:#0b1020;color:#e8ecff;font:15px system-ui}h1{font-size:20px}
main{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
figure{margin:0;background:#151b33;border-radius:12px;overflow:hidden}video{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
figcaption{padding:8px 12px;display:flex;gap:12px;align-items:center}a{color:#ffd23f}</style>
<h1>Vibe Verse gameplay clips (${rows.length})</h1><main>
${cards}
</main>`,
);
console.log(`\n${rows.length} clips in ${out}`);
