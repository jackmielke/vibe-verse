import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const PORT=5188, BASE=`http://127.0.0.1:${PORT}`;
async function up(u,ms){const t=Date.now();while(Date.now()-t<ms){try{const r=await fetch(u);if(r.ok||r.status===404)return true}catch{}await new Promise(r=>setTimeout(r,500))}return false}
const srv=(await up(BASE,1200))?null:spawn("npx",["vite","--port",String(PORT),"--strictPort","--host","127.0.0.1"],{stdio:["ignore","ignore","inherit"],env:{...process.env,BROWSER:"none"}});
if(srv&&!(await up(BASE,120000)))process.exit(1);
const exe="/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const b=await chromium.launch({...(existsSync(exe)?{executablePath:exe}:{}),args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"]});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto(`${BASE}/san-palmas?shot=1`,{waitUntil:"domcontentloaded",timeout:90000});
await p.mouse.click(640,360).catch(()=>{});
await p.waitForTimeout(38000);
const info=await p.evaluate(()=>{
  const e=window.__palmas; if(!e) return {err:"no engine"};
  const pl=e.ctx?.services?.player;
  const cam=e.ctx?.camera;
  return { player: pl?.position?.toArray().map(Math.round), state: pl?.state,
           cam: cam?.position?.toArray().map(Math.round) };
});
console.log(JSON.stringify(info));
await p.screenshot({path:process.argv[2]});
await b.close(); if(srv)srv.kill();
