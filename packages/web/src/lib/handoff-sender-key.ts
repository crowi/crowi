'use client';

/**
 * RFC-0014 — the browser half of the sender-constrained handoff.
 *
 * Phase 1 deliberately does not let a handoff `code` be redeemed by
 * whoever holds it: the code travels back as a URL query parameter, so it
 * is exposed to history, referrers and logs the same way any URL is.
 * Redemption additionally requires an ES256 signature from the P-256 key
 * whose thumbprint was bound into the flow at `/start`. A leaked code on
 * its own is inert.
 *
 * That means this browser has to keep a private key across a full-page
 * round trip through the identity provider. Two properties matter:
 *
 *  - The key is generated NON-EXTRACTABLE and stored as a live
 *    `CryptoKey` in IndexedDB, never as JWK text. Script on the page can
 *    still ask it to sign (that is unavoidable — it must, to complete the
 *    sign-in), but it cannot read the key out and use it elsewhere later.
 *    Storing the JWK in `sessionStorage` would have been far less code
 *    and would have handed any injected script a portable copy.
 *  - It is single-use: `takeStoredSenderKey` deletes as it reads, so a
 *    key left behind by an abandoned attempt cannot be reused by a later
 *    one.
 */

const DB_NAME = 'crowi-auth';
const STORE_NAME = 'handoff-sender-keys';
/** Only ever one flow in flight per tab — a second `/start` replaces the first. */
const RECORD_KEY = 'current';

export interface SenderPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface HandoffSenderKey {
  /** base64url(JSON) of the public JWK — the `handoff_jwk` query parameter `/start` expects. */
  publicJwkB64: string;
  /** The public JWK itself — sent as `proof.publicJwk` when redeeming. */
  publicJwk: SenderPublicJwk;
  /** ES256-sign `message`, returning the base64url JOSE (raw r‖s) signature `/auth/handoff` verifies. */
  sign(message: string): Promise<string>;
  /** RFC 7638 thumbprint of the public JWK — what a link grant is pinned to. */
  thumbprint(): Promise<string>;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runRequest<T>(store: IDBObjectStore, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface StoredSenderKey {
  privateKey: CryptoKey;
  publicJwk: SenderPublicJwk;
  publicJwkB64: string;
}

function toSenderKey(stored: StoredSenderKey): HandoffSenderKey {
  return {
    publicJwkB64: stored.publicJwkB64,
    publicJwk: stored.publicJwk,
    async sign(message: string): Promise<string> {
      const signature = await window.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, stored.privateKey, new TextEncoder().encode(message));
      return base64UrlFromBytes(new Uint8Array(signature));
    },
    async thumbprint(): Promise<string> {
      // The member order below is RFC 7638's required lexicographic
      // ordering for an EC key and MUST match
      // `util/federated-auth-state.ts#computeJwkThumbprint` byte for
      // byte — the server compares the two as strings.
      const canonical = JSON.stringify({ crv: stored.publicJwk.crv, kty: stored.publicJwk.kty, x: stored.publicJwk.x, y: stored.publicJwk.y });
      const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      return base64UrlFromBytes(new Uint8Array(digest));
    },
  };
}

/**
 * Generate a fresh keypair for one sign-in (or link) attempt and persist
 * the private half for the return leg. Returns the public material the
 * caller puts in the `/start` URL.
 */
export async function createAndStoreSenderKey(): Promise<HandoffSenderKey> {
  // `extractable: false` — see the module comment. The public half is
  // exported separately below; the private half never leaves the browser's
  // key store.
  const { publicKey, privateKey } = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const exported = await window.crypto.subtle.exportKey('jwk', publicKey);
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || typeof exported.x !== 'string' || typeof exported.y !== 'string') {
    throw new Error('createAndStoreSenderKey: unexpected exported JWK shape for a P-256 ECDSA key');
  }
  const publicJwk: SenderPublicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  const stored: StoredSenderKey = {
    privateKey,
    publicJwk,
    publicJwkB64: base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(publicJwk))),
  };

  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await runRequest(tx.objectStore(STORE_NAME), tx.objectStore(STORE_NAME).put(stored, RECORD_KEY));
  } finally {
    db.close();
  }

  return toSenderKey(stored);
}

/**
 * Read back the key stored before the IdP round trip, removing it in the
 * same transaction. `null` when there is nothing to take — an expired or
 * already-completed attempt, or a `/login/complete` opened directly.
 */
export async function takeStoredSenderKey(): Promise<HandoffSenderKey | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const stored = (await runRequest(store, store.get(RECORD_KEY))) as StoredSenderKey | undefined;
    // Deleted as part of the same read: an abandoned attempt must not
    // leave a usable key behind for a later one.
    await runRequest(store, store.delete(RECORD_KEY));
    if (!stored?.privateKey) return null;
    return toSenderKey(stored);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * `GET\n<apiUrl>/api/auth/providers/<provider>/start\n<continuePath>\n<publicJwkB64>`
 * — MUST match `util/federated-auth-state.ts#buildStartCanonicalMessage`
 * on the server byte for byte, since that is what the signature is checked
 * against.
 */
export function buildStartCanonicalMessage(apiUrl: string, provider: string, continuePath: string, publicJwkB64: string): string {
  return `GET\n${apiUrl}/api/auth/providers/${encodeURIComponent(provider)}/start\n${continuePath}\n${publicJwkB64}`;
}

/** `POST\n<apiUrl>/api/auth/handoff\n<code>` — mirrors `buildHandoffCanonicalMessage` server-side. */
export function buildHandoffCanonicalMessage(apiUrl: string, code: string): string {
  return `POST\n${apiUrl}/api/auth/handoff\n${code}`;
}
