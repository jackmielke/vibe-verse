import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const PORT = 5177, BASE = `http://127.0.0.1:${PORT}`;
async function up(u, ms){const t=Date.now();while(Date.now()-t<ms){try{const r=await fetch(u);if(r.ok||r.status===404)return true}catch{}await new Promise(r=>setTimeout(r,500))}return false}
const server = (await up(BASE,1200)) ? null : spawn("npx",["vite","--port",String(PORT),"--strictPort","--host","127.0.0.1"],{stdio:["ignore","ignore","inherit"],env:{...process.env,BROWSER:"none"}});
if (server && !(await up(BASE,120000))) process.exit(1);
const exe="/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const b=await chromium.launch({...(existsSync(exe)?{executablePath:exe}:{}),args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"]});
const ctx=await b.newContext({...devices["iPhone 13"]});
const p=await ctx.newPage();
const errs=[];
p.on("pageerror",e=>errs.push("PAGEERROR: "+e.message));
await p.goto(`${BASE}${process.argv[2]}`,{waitUntil:"domcontentloaded",timeout:90000});
await p.waitForTimeout(Number(process.argv[4]??6000));
await p.screenshot({path:process.argv[3],fullPage:process.argv[5]==="full"});
console.log("wrote",process.argv[3]); if(errs.length) console.log(errs.join("\n"));
await b.close(); if(server) server.kill();
