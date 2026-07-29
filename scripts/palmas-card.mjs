import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const PORT=5177, BASE=`http://127.0.0.1:${PORT}`;
async function up(u,ms){const t=Date.now();while(Date.now()-t<ms){try{const r=await fetch(u);if(r.ok||r.status===404)return true}catch{}await new Promise(r=>setTimeout(r,500))}return false}
const server=(await up(BASE,1200))?null:spawn("npx",["vite","--port",String(PORT),"--strictPort","--host","127.0.0.1"],{stdio:["ignore","ignore","inherit"],env:{...process.env,BROWSER:"none"}});
if(server&&!(await up(BASE,120000)))process.exit(1);
const exe="/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const b=await chromium.launch({...(existsSync(exe)?{executablePath:exe}:{}),args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"]});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto(`${BASE}/san-palmas?shot=1`,{waitUntil:"domcontentloaded",timeout:90000});
await p.mouse.click(800,450).catch(()=>{});
await p.waitForFunction(()=>window.__palmasReady===true,null,{timeout:180000}).catch(()=>console.log("warn: never ready"));
await p.waitForTimeout(28000);
// Pose the camera directly: elevated, looking slightly down across the city.
const info = await p.evaluate(() => {
  const eng = window.__palmas; if (!eng) return "no engine";
  const cam = eng.ctx?.camera ?? eng.camera; if (!cam) return "no camera:" + Object.keys(eng).join(",");
  cam.position.set(120, 165, 320);
  cam.rotation.order = "YXZ";
  cam.rotation.set(-0.30, 0.45, 0);   // pitch down 17°, yaw across the skyline
  cam.updateProjectionMatrix();
  return "posed @" + cam.position.toArray().map(Math.round).join(",");
});
console.log(info);
await p.waitForTimeout(9000);
const png=await p.screenshot();
const jpeg=await p.evaluate(async d=>{const i=new Image();i.src="data:image/png;base64,"+d;await i.decode();const W=960,H=Math.round(i.height/i.width*W);const c=document.createElement("canvas");c.width=W;c.height=H;c.getContext("2d").drawImage(i,0,0,W,H);return c.toDataURL("image/jpeg",.88)},png.toString("base64"));
writeFileSync(process.argv[2],Buffer.from(jpeg.split(",")[1],"base64"));
console.log("wrote",process.argv[2]);
await b.close(); if(server)server.kill();
