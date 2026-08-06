import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
async function up(url, ms){const t0=Date.now();while(Date.now()-t0<ms){try{const r=await fetch(url);if(r.ok||r.status===404)return true;}catch{}await new Promise(r=>setTimeout(r,500));}return false;}

const server = (await up(BASE,1200)) ? null : spawn("npx",["vite","--port",String(PORT),"--strictPort","--host","127.0.0.1"],{stdio:["ignore","ignore","inherit"],env:{...process.env,BROWSER:"none"}});
if(server && !(await up(BASE,180000))){console.error("no server");process.exit(1);}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({...(existsSync(exe)?{executablePath:exe}:{}),args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--no-sandbox","--disable-dev-shm-usage","--js-flags=--max-old-space-size=4096"]});
const page = await browser.newPage({viewport:{width:800,height:450}});
page.on("pageerror",e=>console.log("PAGEERROR:",e.message));
page.on("console",m=>{const t=m.text(); if(/veg|Drop Zero|error|warn/i.test(t)) console.log(`[${m.type()}]`,t.slice(0,300));});
await page.goto(`${BASE}/drop-zero?shot=1`,{waitUntil:"domcontentloaded",timeout:180000});
try{ await page.waitForFunction("window.__dzReady === true",null,{timeout:600000}); }catch{ console.log("never ready"); }
console.log("booted");

await page.evaluate(`(()=>{const e=window.__dz;const m=e?.ctx?.services?.match;const p=e?.ctx?.services?.player;const t=e?.ctx?.services?.terrain;if(m&&m.jump)m.jump();if(p&&t)p.teleport(new (e.ctx.camera.position.constructor)(-260,t.heightAt(-260,300)+2,300));})()`).catch(e=>console.log("skip threw",e.message));
await page.waitForTimeout(20000);

const dump = await page.evaluate(`(()=>{
  const e=window.__dz; const s=e.ctx.scene;
  const root=s.getObjectByName("dz:vegetation");
  const out={cam:e.ctx.camera.position.toArray().map(v=>Math.round(v)), quality:e.ctx.quality, stats:e.stats, root:!!root};
  if(root){
    out.children=root.children.length;
    let live=0, tot=0; const nonzero=[];
    for(const c of root.children){ tot++; if(c.count>0){live++; nonzero.push([c.name,c.count]);} }
    out.live=live; out.total=tot; out.nonzero=nonzero.slice(0,60);
    out.rootVisible=root.visible;
    const b=new (e.ctx.camera.position.constructor.prototype.constructor)();
    const THREEBox = s.constructor; 
  }
  const t=e.ctx.services.terrain;
  if(t){ out.h=t.heightAt(-260,300); out.sea=t.seaLevel; out.slope=t.slopeAt?t.slopeAt(-260,300):null; out.w=t.surfaceWeightsAt?Array.from(t.surfaceWeightsAt(-260,300)):null; out.mat=t.materialAt?t.materialAt(-260,300):null;}
  out.pois=(e.ctx.services.pois||[]).map(p=>[p.name,Math.round(p.center.x),Math.round(p.center.z),Math.round(p.radius)]);
  return JSON.stringify(out);
})()`);
console.log(dump);
await browser.close();
if(server) server.kill();
process.exit(0);
