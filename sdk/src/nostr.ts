import { chacha20 } from "@noble/ciphers/chacha.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "../../core/bytes.js";

const NIP44_SALT = new TextEncoder().encode("nip44-v2");
const NIP44_VERSION = 2;
const NONCE_BYTES = 32;
const MAC_BYTES = 32;
const MESSAGE_KEYS_BYTES = 76;
const CHACHA_KEY_END = 32;
const CHACHA_NONCE_END = 44;
const LENGTH_PREFIX_BYTES = 2;
const SMALLEST_PAD = 32;
const CHUNKS_STAY_SMALL_TO = 256;
const MAX_PLAINTEXT_BYTES = 65_535;

/** A nostr event as NIP-01 puts it on the wire, snake_case and all */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Everything about an event except what signing derives from it */
export interface EventDraft {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

export function publicKeyFor(privateKeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
}

/**
 * The NIP-44 conversation key, which is the same in both directions and is what
 * every message between these two keys derives its own keys from
 */
export function conversationKeyFor(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  const shared = secp256k1.getSharedSecret(
    hexToBytes(privateKeyHex),
    hexToBytes(`02${publicKeyHex}`),
  );

  return extract(sha256, shared.subarray(1, 33), NIP44_SALT);
}

/** Sign a draft into a full event, hashing it to its id the way NIP-01 spells out */
export function signEvent(privateKeyHex: string, draft: EventDraft): NostrEvent {
  const pubkey = publicKeyFor(privateKeyHex);
  const id = idOf(pubkey, draft);

  return {
    id,
    pubkey,
    created_at: draft.created_at,
    kind: draft.kind,
    tags: draft.tags,
    content: draft.content,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(privateKeyHex))),
  };
}

/**
 * Whether an event hashes to the id it claims and carries the signature of the
 * key it claims, which is all a relay handing it to us has earned
 */
export function verifyEvent(event: NostrEvent): boolean {
  try {
    return (
      idOf(event.pubkey, event) === event.id &&
      schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
    );
  } catch {
    return false;
  }
}

function idOf(pubkey: string, draft: EventDraft): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([0, pubkey, draft.created_at, draft.kind, draft.tags, draft.content]),
      ),
    ),
  );
}

export function encryptNip44(conversationKey: Uint8Array, plaintext: string): string {
  return sealNip44(conversationKey, plaintext, crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Encrypt under a nonce you chose. Only a test has any business choosing one, so
 * everything else calls `encryptNip44` and gets a fresh one it cannot reuse
 */
export function sealNip44(
  conversationKey: Uint8Array,
  plaintext: string,
  nonce: Uint8Array,
): string {
  const keys = messageKeysFrom(conversationKey, nonce);
  const ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, padded(plaintext));
  const mac = hmac(sha256, keys.hmacKey, joined(nonce, ciphertext));

  return toBase64(joined(Uint8Array.of(NIP44_VERSION), nonce, ciphertext, mac));
}

/**
 * Read a NIP-44 payload back. Throws on anything that is not one of ours, which
 * for a relay's answer means the wallet we asked did not write it
 */
export function decryptNip44(conversationKey: Uint8Array, payload: string): string {
  if (payload.startsWith("#")) {
    throw new Error("nip44 payload announces an encryption version we do not speak");
  }

  const raw = fromBase64(payload);
  if (raw.length < 1 + NONCE_BYTES + MAC_BYTES) {
    throw new Error(`nip44 payload is ${raw.length} bytes, too short to hold a nonce and a mac`);
  }
  if (raw[0] !== NIP44_VERSION) {
    throw new Error(`nip44 payload is version ${raw[0]}, not ${NIP44_VERSION}`);
  }

  const nonce = raw.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = raw.subarray(1 + NONCE_BYTES, raw.length - MAC_BYTES);
  const mac = raw.subarray(raw.length - MAC_BYTES);
  const keys = messageKeysFrom(conversationKey, nonce);
  if (!sameBytes(hmac(sha256, keys.hmacKey, joined(nonce, ciphertext)), mac)) {
    throw new Error("nip44 payload failed its mac, so it was not written with this key");
  }

  return unpadded(chacha20(keys.chachaKey, keys.chachaNonce, ciphertext));
}

function messageKeysFrom(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== NONCE_BYTES || nonce.length !== NONCE_BYTES) {
    throw new Error("a nip44 conversation key and nonce are both 32 bytes");
  }

  const keys = expand(sha256, conversationKey, nonce, MESSAGE_KEYS_BYTES);

  return {
    chachaKey: keys.subarray(0, CHACHA_KEY_END),
    chachaNonce: keys.subarray(CHACHA_KEY_END, CHACHA_NONCE_END),
    hmacKey: keys.subarray(CHACHA_NONCE_END),
  };
}

export function paddedLengthFor(unpadded: number): number {
  if (unpadded <= SMALLEST_PAD) {
    return SMALLEST_PAD;
  }

  const nextPower = 1 << (Math.floor(Math.log2(unpadded - 1)) + 1);
  const chunk = nextPower <= CHUNKS_STAY_SMALL_TO ? SMALLEST_PAD : nextPower / 8;

  return chunk * (Math.floor((unpadded - 1) / chunk) + 1);
}

function padded(plaintext: string): Uint8Array {
  const body = new TextEncoder().encode(plaintext);
  if (body.length === 0 || body.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`nip44 takes 1 to ${MAX_PLAINTEXT_BYTES} bytes, this was ${body.length}`);
  }

  const buffer = new Uint8Array(LENGTH_PREFIX_BYTES + paddedLengthFor(body.length));
  buffer.set(Uint8Array.of(body.length >>> 8, body.length & 0xff));
  buffer.set(body, LENGTH_PREFIX_BYTES);

  return buffer;
}

function unpadded(buffer: Uint8Array): string {
  const length = ((buffer[0] ?? 0) << 8) | (buffer[1] ?? 0);
  if (length === 0 || buffer.length !== LENGTH_PREFIX_BYTES + paddedLengthFor(length)) {
    throw new Error("nip44 plaintext does not match the length its own padding declares");
  }

  return new TextDecoder().decode(
    buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length),
  );
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }

  return whole;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  let different = left.length ^ right.length;
  for (let at = 0; at < left.length && at < right.length; at++) {
    different |= (left[at] ?? 0) ^ (right[at] ?? 0);
  }

  return different === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < bytes.length; at++) {
    bytes[at] = binary.charCodeAt(at);
  }

  return bytes;
}
