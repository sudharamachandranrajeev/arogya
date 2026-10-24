// Browser walk-through of safety and security flows against a running demo server.
// usage: node test/e2e/ui.mjs http://127.0.0.1:8080 [chromium-path]
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const [base = 'http://127.0.0.1:8080', exe = process.env.CHROME ?? '/usr/bin/chromium'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];
const page = async () => {
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
};
const signIn = async (p, user, ready = '.side') => {
  await p.goto(base + '/');
  await p.fill('input[autocomplete=username]', user);
  await p.fill('input[type=password]', 'arogya-demo-2026');
  await p.click('button.primary');
  await p.waitForSelector(ready);
};
const step = (s) => console.log('✓', s);

// Clinician: palette, restricted record, prescribing stop.
const p = await page();
await signIn(p, 'mehta');
await p.keyboard.press('Control+k');
await p.keyboard.type('A100000'); // the restricted demo patient
await p.waitForSelector('.palette li.on');
await p.keyboard.press('Enter');
await p.waitForSelector('text=Restricted record');
assert.equal(await p.isDisabled('button:has-text("Open record")'), true);
await p.fill('textarea', 'Covering clinic today, patient attending');
await p.click('button:has-text("Open record")');
await p.waitForSelector('.patient-banner');
await p.waitForSelector('text=This access is logged');
step('restricted record needs a stated reason');

await p.fill('input[placeholder^="Add an allergy"]', 'Penicillin');
await p.press('input[placeholder^="Add an allergy"]', 'Enter');
await p.waitForSelector('.allergy-strip .chip.bad');
await p.fill('input[placeholder^="Prescribe"]', 'Amoxicillin 500 mg');
await p.waitForSelector('text=Stop and check');
assert.equal(await p.isDisabled('button:has-text("Prescribe")'), true);
await p.fill('input[placeholder^="Clinical reason"]', 'Tolerated amoxicillin in 2024');
await p.click('button:has-text("Prescribe")');
await p.waitForSelector('.toast:has-text("prescribed")');
step('allergy blocks prescribing until a reason is given');

await p.fill('textarea', 'Review .nad ');
assert.match(await p.inputValue('textarea'), /No abnormality detected/);
await p.fill('textarea', 'BP ___');
assert.equal(await p.isDisabled('button:has-text("Sign note")'), true);
step('note phrases expand; blanks block signing');

await p.click('button:has-text("Lock")');
await p.waitForSelector('text=Screen locked');
await p.fill('input[type=password]', 'arogya-demo-2026');
await p.click('button.primary');
await p.locator('.patient-banner').or(p.getByText('Restricted record')).first().waitFor();
step('lock screen hides the record and returns to it');

// Recalls: an overdue patient is booked straight from the list.
await p.goto(base + '/recalls');
await p.waitForSelector('text=Overdue');
const row = p.locator('tr').filter({ has: p.locator('text=Overdue') }).filter({ has: p.locator('button:has-text("Book")') }).first();
const who = await row.locator('td b').textContent();
await row.locator('button:has-text("Book")').click();
await p.waitForSelector(`text=Recall:`);
await p.locator('.split button', { hasText: ':' }).first().click();
await p.waitForSelector(`.toast:has-text("${who} booked")`);
await p.goto(base + '/recalls');
await p.locator('tr', { hasText: who }).locator('text=Booked').first().waitFor();
step('overdue recall booked from the list');

// A noisy alert rule stops interrupting, with a reason.
await p.goto(base + '/dashboard');
await p.locator('tr', { hasText: 'spironolactone with ramipril' }).locator('button:has-text("Stop interrupting")').click();
await p.fill('input[placeholder^="Clinical reason"]', 'Heart failure clinic co-prescribes with potassium checks');
await p.click('button:has-text("Confirm")');
await p.waitForSelector('text=not interrupting');
step('noisy alert rule quietened with a reason');

// Reception: merge a duplicate, then undo it.
const r = await page();
await signIn(r, 'reception');
await r.goto(base + '/patients');
await r.click('button:has-text("Possible duplicates")');
await r.waitForSelector('.dup');
await r.locator('.dup button:has-text("Merge")').first().click();
assert.equal(await r.isDisabled('button:has-text("Merge records")'), true);
await r.fill('.merge-box input[placeholder^="How you confirmed"]', 'Checked photo ID and address at the desk');
await r.click('button:has-text("Merge records")');
await r.waitForSelector('.toast:has-text("Records merged")');
await r.click('button:has-text("Undo")');
await r.waitForSelector('.toast:has-text("Merge undone")');
step('duplicate merged and the merge undone');

// Nurse: forced two-step enrolment end to end.
const a = await page();
await signIn(a, 'admin');
await a.goto(base + '/admin', { waitUntil: 'networkidle' });
await a.check('label:has-text("nurse") input');
await a.click('button:has-text("Save policy")');
await a.waitForSelector('.toast:has-text("Security policy saved")');
const n = await page();
await signIn(n, 'nurse', 'text=Your role must use two-step verification');
await n.click('button:has-text("Set up")');
const key = (await n.textContent('code.secret')).replace(/\s/g, '');
await n.fill('input[autocomplete=one-time-code]', totp(key, Math.floor(Date.now() / 30000)));
await n.click('button:has-text("Turn on")');
await n.waitForSelector('.side');
step('nurse forced through two-step set-up');

assert.deepEqual(errors, [], errors.join('\n'));
await b.close();
console.log('e2e passed');

function totp(secret, step) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of secret) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
