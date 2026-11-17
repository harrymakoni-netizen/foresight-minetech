// Personal data at rest (spec §15): phone numbers are sealed with AES-256-GCM
// and looked up by a keyed hash, so a database read alone does not reveal
// them. Only supervisors and administrators receive unsealed values; logs,
// AI requests and other roles see masks.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { ConfigurationError } from "./configuration.ts";

let cached: { enc: Buffer; mac: Buffer; source: string } | undefined;
export function personalKeySource() {
  try {
    return keys().source;
  } catch {
    return "not-configured";
  }
}
function keys() {
  if (cached) return cached;
  const raw = process.env.FORESIGHT_PERSONAL_DATA_KEY;
  let master: Buffer, source: string;
  if (raw) {
    master = Buffer.from(raw, "base64");
    if (master.length !== 32)
      throw new ConfigurationError(
        "FORESIGHT_PERSONAL_DATA_KEY must be 32 bytes, base64-encoded.",
      );
    source = "configured";
  } else if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new ConfigurationError(
      "Personal data key is not configured. Set FORESIGHT_PERSONAL_DATA_KEY before storing phone numbers.",
    );
  } else {
    // Local development only: a fixed, published key. Not protection.
    master = Buffer.alloc(32, 7);
    source = "development-insecure";
  }
  const derive = (info: string) =>
    Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  cached = { enc: derive("foresight-phone-enc-v1"), mac: derive("foresight-phone-hash-v1"), source };
  return cached;
}
export function normalisePhone(phone: string) {
  const v = phone.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(v)) throw new Error("Invalid phone number");
  return v;
}
export function phoneHash(phone: string) {
  return createHmac("sha256", keys().mac).update(normalisePhone(phone)).digest("hex");
}
export function seal(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", keys().enc, iv),
    body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function unseal(sealed: string) {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown sealed format");
  const buf = Buffer.from(sealed.slice(3), "base64"),
    decipher = createDecipheriv("aes-256-gcm", keys().enc, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
export function maskPhone(phone: string) {
  return phone.length > 6 ? phone.slice(0, 4) + "•••••" + phone.slice(-3) : "•••";
}
export function sealedPhone(phone: string | null) {
  if (!phone) return { phoneSealed: null, phoneMasked: null, phoneHash: null };
  const p = normalisePhone(phone);
  return { phoneSealed: seal(p), phoneMasked: maskPhone(p), phoneHash: phoneHash(p) };
}
export const canSeePersonal = (role: string) =>
  role === "supervisor" || role === "administrator";
