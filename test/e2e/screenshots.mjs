// README screenshots against a fresh demo server (synthetic patients only).
// usage: node test/e2e/screenshots.mjs http://127.0.0.1:8080 [out-dir] [chromium-path]
// Start the server with AROGYA_DEMO=1 and throwaway AROGYA_DATA / AROGYA_KEY_FILE paths.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [base = 'http://127.0.0.1:8080', out = 'docs/screenshots', exe = process.env.CHROME ?? '/usr/bin/chromium'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function session(user, colorScheme) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(base + '/');
  await p.fill('input[autocomplete=username]', user);
  await p.fill('input[type=password]', 'arogya-demo-2026');
  await p.click('button.primary');
  await p.waitForSelector('.side');
  return p;
}
async function shot(p, path, name, ready) {
  await p.goto(base + path);
  if (ready) await p.waitForSelector(ready);
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/${name}.png` });
  console.log('✓', name);
}
// A100012 has a problem, a medication, an HbA1c and a blood pressure in the demo seed.
async function openPatient(p, mrn = 'A100012') {
  await p.keyboard.press('Control+k');
  await p.keyboard.type(mrn);
  await p.waitForSelector('.palette li.on');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.patient-banner');
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(600);
}

for (const scheme of ['light', 'dark']) {
  const p = await session('mehta', scheme);
  await shot(p, '/today', `today-${scheme}`);
  await openPatient(p);
  await p.screenshot({ path: `${out}/chart-${scheme}.png` });
  console.log('✓', `chart-${scheme}`);
  if (scheme === 'light') {
    await shot(p, '/inbox', 'inbox-light');
    await shot(p, '/recalls', 'recalls-light', 'text=Overdue');
  }
  await p.context().close();
}
const m = await session('manager', 'light');
await shot(m, '/dashboard', 'dashboard-light');
await m.context().close();
await b.close();
