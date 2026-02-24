import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { computeAttestationHash, encodeAttestationPayload, hashAttestationPayload } from '../attestation';

const INPUT = {
  authority: '8qbHbw2BbbTHBW1sbn4j4d93M2D8v1jQ7Rj4tTBW5u7x',
  positionMint: 'CktRuQ3fQY4MReLRUdM8x22VPA7v2ecx2M4HX8QYfF9u',
  epoch: 19770,
  direction: 0 as const,
  lowerTickIndex: -1200,
  upperTickIndex: 1200,
  currentTickIndex: -1250,
  observedSlot: 312345678n,
  observedUnixTs: 1708747200n,
  quoteInputMint: 'So11111111111111111111111111111111111111112',
  quoteOutputMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  quoteInAmount: 123456789n,
  quoteOutAmount: 45670000n,
  quoteSlippageBps: 50,
  quoteQuotedAtUnixMs: 1708747200123n,
  computeUnitLimit: 600000,
  computeUnitPriceMicroLamports: 10000n,
  maxSlippageBps: 50,
  quoteFreshnessMs: 20000n,
  maxRebuildAttempts: 3,
};

describe('attestation encoding/hash', () => {
  it('is deterministic for same input and stable by construction', () => {
    const aBytes = encodeAttestationPayload(INPUT);
    const bBytes = encodeAttestationPayload({ ...INPUT });
    const aHash = computeAttestationHash(INPUT);
    const bHash = computeAttestationHash({ ...INPUT });

    expect(Buffer.from(aBytes).equals(Buffer.from(bBytes))).toBe(true);
    expect(Buffer.from(aHash).equals(Buffer.from(bHash))).toBe(true);
  });

  it('changes hash when one field mutates', () => {
    const base = computeAttestationHash(INPUT);
    const mutated = computeAttestationHash({ ...INPUT, quoteOutAmount: INPUT.quoteOutAmount + 1n });
    expect(Buffer.from(base).equals(Buffer.from(mutated))).toBe(false);
  });

  it('matches golden vector + payload length', () => {
    const payload = encodeAttestationPayload(INPUT);
    const hash = computeAttestationHash(INPUT);

    expect(payload.length).toBe(217);
    expect(Buffer.from(hash).toString('hex')).toBe('6c4ac83dfae26bcc68f3093dc342110bdabead4577fbd4b7903607dfea945b26');
  });

  it('matches node crypto sha256 reference across payload sizes', () => {
    const payloads = [
      new Uint8Array([]),
      new Uint8Array([1]),
      new Uint8Array(55).fill(0xab),
      new Uint8Array(56).fill(0xcd),
      new Uint8Array(57).fill(0xef),
      encodeAttestationPayload(INPUT),
    ];

    for (const payload of payloads) {
      const ours = Buffer.from(hashAttestationPayload(payload)).toString('hex');
      const node = createHash('sha256').update(Buffer.from(payload)).digest('hex');
      expect(ours).toBe(node);
    }
  });
});
