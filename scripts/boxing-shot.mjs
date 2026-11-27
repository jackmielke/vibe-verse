import { chromium } from 'playwright';
import fs from 'node:fs';
const out = '/tmp/claude-0/box';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:5173/boxing', { waitUntil: 'load' });
await page.waitForFunction(() => window.__boxing, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const save = async (name) => {
  const d = await page.evaluate(() => window.__boxing.snapshot());
  if (d) fs.writeFileSync(`${out}/${name}.jpg`, Buffer.from(d.split(',')[1], 'base64'));
};
await page.screenshot({ path: `${out}/splash-dom.png` });
await save('splash');
const mode = process.argv[2] || 'thumbs';
await page.evaluate((m) => window.__boxing.start(m), mode);
await page.waitForTimeout(mode === 'camera' ? 15000 : 1500);
console.log('hud', JSON.stringify(await page.evaluate(() => { const h = window.__boxing.hud(); return { ...h, body: h.body && { present: h.body.present } }; })));
if (mode === 'camera') { await save('setup'); await page.screenshot({ path: `${out}/setup-dom.png` }); await page.evaluate(() => window.__boxing.fight()); }
await page.evaluate(() => window.__boxing.freeze(true));
console.log(JSON.stringify(await page.evaluate(() => window.__boxing.settle(3))));
// run to a windup
for (let i = 0; i < 40; i++) { const r = await page.evaluate(() => window.__boxing.settle(0.1)); if (r.phase === 'windup') break; }
await page.evaluate(() => window.__boxing.settle(0.3));
await save('windup');
await page.screenshot({ path: `${out}/windup-dom.png` });
// slip it
const side = await page.evaluate(() => window.__boxing.bout().opp.side);
for (let i = 0; i < 30; i++) { const r = await page.evaluate((l) => window.__boxing.settle(0.05, { lean: l }), side === 'R' ? -1 : 1); if (r.phase === 'open') break; }
await page.evaluate(() => window.__boxing.settle(0.2));
await save('open');
await page.evaluate(() => window.__boxing.settle(0.05, { punches: [{ hand: 'L', kind: 'hook', power: 1 }] }));
await page.evaluate(() => window.__boxing.settle(0.12));
await save('hit');
console.log(JSON.stringify(await page.evaluate(() => window.__boxing.settle(0.1))));
await page.screenshot({ path: `${out}/hit-dom.png` });
console.log(errs.slice(0, 15).join('\n'));
await browser.close();
