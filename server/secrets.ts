import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let key: Buffer = randomBytes(32);

/**
 * The application key seals secrets stored in the database (TOTP seeds). It comes from AROGYA_KEY (base64, 32 bytes)
 * or a 0600 key file created beside the data directory. Without it, a stolen database alone does not reveal MFA seeds.
 */
export function loadKey(file = process.env.AROGYA_KEY_FILE ?? '.data/secret.key') {
  if (process.env.AROGYA_KEY) {
    key = Buffer.from(process.env.AROGYA_KEY, 'base64');
    if (key.length !== 32) throw new Error('AROGYA_KEY must be 32 bytes, base64-encoded');
    return;
  }
  if (existsSync(file)) key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}

export function seal(plain: string, k = key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function unseal(sealed: string, k = key) {
  const b = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string) {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secret: string, step: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

/** The matching time step within ±1 step of clock drift, or null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const s = currentStep(now);
  for (const d of [0, -1, 1]) if (totp(secret, s + d) === code) return s + d;
  return null;
}

export const newTotpSecret = () => base32(randomBytes(20));

// ---------- passphrase encryption for backups ----------
const MAGIC = Buffer.from('AROGYABK1');
export function encryptWithPassphrase(data: Buffer, passphrase: string) {
  const salt = randomBytes(16);
  const k = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}
export function decryptWithPassphrase(file: Buffer, passphrase: string) {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Arogya backup');
  let o = MAGIC.length;
  const salt = file.subarray(o, (o += 16)), iv = file.subarray(o, (o += 12)), tag = file.subarray(o, (o += 16));
  const k = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(file.subarray(o)), d.final()]); } catch { throw new Error('Wrong passphrase or damaged backup'); }
}
