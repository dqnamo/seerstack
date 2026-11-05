// Small secrets derived from ANON_SALT, each under its own HKDF label:
// - seal/unseal encrypt short-lived credentials (a PostHog API key) so they can
//   travel in Workflow params, which Cloudflare stores and shows, unreadably;
// - signToken/verifyToken sign the owner's sign-in cookies for Seerstack's pages.

const encoder = new TextEncoder();

async function derivedKey(
  secret: string,
  label: string,
  algorithm: { name: "AES-GCM"; length: number } | { name: "HMAC"; hash: string },
) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(label) },
    material,
    algorithm,
    false,
    algorithm.name === "HMAC" ? ["sign", "verify"] : ["encrypt", "decrypt"],
  );
}

const aesKey = (secret: string) => derivedKey(secret, "seerstack import credentials", { name: "AES-GCM", length: 256 });

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64Url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string) => fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));

export async function seal(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(secret),
    encoder.encode(plaintext),
  );
  const sealed = new Uint8Array(iv.length + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(sealed);
}

export async function unseal(sealed: string, secret: string): Promise<string> {
  const bytes = fromBase64(sealed);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await aesKey(secret),
    bytes.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

// A signed, expiring token: base64url(JSON) "." base64url(HMAC). The label
// keeps tokens for one purpose from being accepted for another.
export async function signToken(payload: object, ttlMs: number, secret: string, label: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })));
  const key = await derivedKey(secret, label, { name: "HMAC", hash: "SHA-256" });
  return `${body}.${toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}

export async function verifyToken<T>(token: string, secret: string, label: string): Promise<T | null> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  try {
    const key = await derivedKey(secret, label, { name: "HMAC", hash: "SHA-256" });
    if (!(await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), encoder.encode(body)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T & { exp: number };
    return typeof payload.exp === "number" && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
