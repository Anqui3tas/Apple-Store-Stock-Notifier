// node scripts/vapid.mjs  -> prints VAPID_PUBLIC (for wrangler.toml) and VAPID_PRIVATE_JWK (wrangler secret)
import { webcrypto as c } from "node:crypto";
const kp = await c.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = Buffer.from(await c.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const jwk = await c.subtle.exportKey("jwk", kp.privateKey);
console.log("VAPID_PUBLIC=" + raw);
console.log("VAPID_PRIVATE_JWK=" + JSON.stringify(jwk));
