import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../../core/bytes.js";
import {
  conversationKeyFor,
  decryptNip44,
  encryptNip44,
  paddedLengthFor,
  publicKeyFor,
  sealNip44,
  signEvent,
} from "../src/nostr";
import vectors from "./nip44.vectors.json" with { type: "json" };

const v2 = vectors.v2;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("the official nip44 vectors", () => {
  it("derives every conversation key", () => {
    for (const vector of v2.valid.get_conversation_key) {
      expect(bytesToHex(conversationKeyFor(vector.sec1, vector.pub2))).toBe(
        vector.conversation_key,
      );
    }
  });

  it("pads to every documented length", () => {
    for (const [unpadded, padded] of v2.valid.calc_padded_len) {
      expect(paddedLengthFor(unpadded)).toBe(padded);
    }
  });

  it("reads back every payload", () => {
    for (const vector of v2.valid.encrypt_decrypt) {
      expect(decryptNip44(hexToBytes(vector.conversation_key), vector.payload)).toBe(
        vector.plaintext,
      );
    }
  });

  it("writes every payload byte for byte, given the vector's own nonce", () => {
    for (const vector of v2.valid.encrypt_decrypt) {
      expect(
        sealNip44(hexToBytes(vector.conversation_key), vector.plaintext, hexToBytes(vector.nonce)),
      ).toBe(vector.payload);
    }
  });

  it("writes a long payload to the documented hash", () => {
    for (const vector of v2.valid.encrypt_decrypt_long_msg) {
      const plaintext = vector.pattern.repeat(vector.repeat);
      expect(sha256Hex(plaintext)).toBe(vector.plaintext_sha256);
      expect(
        sha256Hex(
          sealNip44(hexToBytes(vector.conversation_key), plaintext, hexToBytes(vector.nonce)),
        ),
      ).toBe(vector.payload_sha256);
    }
  });

  it("refuses a plaintext past the length its prefix can carry", () => {
    const key = hexToBytes(v2.valid.encrypt_decrypt[0].conversation_key);

    expect(() => encryptNip44(key, "a".repeat(65_536))).toThrow(/65535/);
  });

  it("refuses every payload the vectors call invalid", () => {
    for (const vector of v2.invalid.decrypt) {
      expect(() => decryptNip44(hexToBytes(vector.conversation_key), vector.payload)).toThrow();
    }
  });

  it("refuses a conversation key the vectors call invalid", () => {
    for (const vector of v2.invalid.get_conversation_key) {
      expect(() => conversationKeyFor(vector.sec1, vector.pub2)).toThrow();
    }
  });
});

describe("nip44 round trip", () => {
  const alice = "01".padStart(64, "0");
  const bob = "02".padStart(64, "0");

  it("reads back what it wrote, both directions", () => {
    const toBob = conversationKeyFor(alice, publicKeyFor(bob));
    const toAlice = conversationKeyFor(bob, publicKeyFor(alice));
    const message = JSON.stringify({ method: "lookup_invoice", params: { payment_hash: "ab" } });

    expect(bytesToHex(toBob)).toBe(bytesToHex(toAlice));
    expect(decryptNip44(toAlice, encryptNip44(toBob, message))).toBe(message);
  });

  it("writes a different payload every time, because the nonce is fresh", () => {
    const key = conversationKeyFor(alice, publicKeyFor(bob));

    expect(encryptNip44(key, "same")).not.toBe(encryptNip44(key, "same"));
  });

  it("refuses a payload a second key touched", () => {
    const written = encryptNip44(conversationKeyFor(alice, publicKeyFor(bob)), "for bob only");
    const stranger = conversationKeyFor("03".padStart(64, "0"), publicKeyFor(bob));

    expect(() => decryptNip44(stranger, written)).toThrow(/mac/);
  });

  it("refuses an empty plaintext", () => {
    expect(() => encryptNip44(conversationKeyFor(alice, publicKeyFor(bob)), "")).toThrow();
  });
});

describe("signing an event", () => {
  const key = "0000000000000000000000000000000000000000000000000000000000000001";

  it("hashes the event to the id nip-01 defines", () => {
    const draft = { kind: 23194, tags: [["p", "ab"]], content: "sealed", created_at: 1_700_000_000 };
    const event = signEvent(key, draft);
    const serialised = JSON.stringify([
      0,
      event.pubkey,
      draft.created_at,
      draft.kind,
      draft.tags,
      draft.content,
    ]);

    expect(event.id).toBe(sha256Hex(serialised));
    expect(event.pubkey).toBe(publicKeyFor(key));
    expect(event.sig).toHaveLength(128);
  });

  it("signs with a schnorr signature the curve verifies", async () => {
    const { schnorr } = await import("@noble/curves/secp256k1.js");
    const event = signEvent(key, { kind: 23194, tags: [], content: "x", created_at: 1 });

    expect(
      schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey)),
    ).toBe(true);
  });
});
