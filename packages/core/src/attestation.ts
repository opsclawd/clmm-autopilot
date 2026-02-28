import type { SolanaCluster } from './mints';
import type { SwapRouter } from './config';
import { SWAP_ROUTER_TO_CODE, SWAP_SKIP_REASON_TO_CODE, type SwapSkipReason } from './swap';

export type AttestationDirection = 0 | 1;

export const ATTESTATION_VERSION = 2;

export type AttestationInput = {
  attestationVersion?: number;
  cluster: SolanaCluster | number;
  authority: string | Uint8Array;
  position: string | Uint8Array;
  positionMint: string | Uint8Array;
  whirlpool: string | Uint8Array;
  epoch: number;
  direction: AttestationDirection;
  tickCurrent: number;
  lowerTickIndex: number;
  upperTickIndex: number;
  slippageBpsCap: number;
  quoteInputMint: string | Uint8Array;
  quoteOutputMint: string | Uint8Array;
  quoteInAmount: bigint;
  quoteMinOutAmount: bigint;
  quoteQuotedAtUnixSec?: number;
  quoteQuotedAtUnixMs?: bigint;
  swapPlanned: number;
  swapSkipReason?: number | SwapSkipReason;
  swapRouter?: number | SwapRouter;
  // Backward-compatible legacy fields.
  swapExecuted?: number;
  swapReasonCode?: number;
};

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(BASE58_ALPHABET.split('').map((ch, idx) => [ch, idx]));

function base58Decode(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  const bytes: number[] = [0];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const carry0 = BASE58_MAP.get(ch);
    if (carry0 === undefined) throw new Error(`Invalid base58 character: ${ch}`);
    let carry = carry0;
    for (let j = 0; j < bytes.length; j += 1) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  for (let i = 1; i < leadingZeroes; i += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

function toPubkey32(value: string | Uint8Array): Uint8Array {
  const out = typeof value === 'string' ? base58Decode(value) : value;
  if (out.length !== 32) throw new Error('Pubkey must decode to exactly 32 bytes');
  return out;
}

function u8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error('u8 out of range');
  return Uint8Array.from([value]);
}

function u16le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('u16 out of range');
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}

function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('u32 out of range');
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}

function i32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error('i32 out of range');
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value, true);
  return b;
}

function u64le(value: bigint): Uint8Array {
  if (value < BigInt(0) || value > BigInt('0xffffffffffffffff')) throw new Error('u64 out of range');
  const b = new Uint8Array(8);
  let n = value;
  for (let i = 0; i < 8; i += 1) {
    b[i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function hashAttestationPayload(bytes: Uint8Array): Uint8Array {
  const bitLen = BigInt(bytes.length) * BigInt(8);
  const padLen = (((bytes.length + 9 + 63) >> 6) << 6) - bytes.length;
  const msg = new Uint8Array(bytes.length + padLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  for (let i = 0; i < 8; i += 1) {
    const shift = BigInt((7 - i) * 8);
    msg[msg.length - 8 + i] = Number((bitLen >> shift) & BigInt(0xff));
  }
  const view = new DataView(msg.buffer);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const W = new Uint32Array(64);
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t += 1) W[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, H[i], false);
  return out;
}

function clusterToU8(cluster: SolanaCluster | number): number {
  if (typeof cluster === 'number') return cluster;
  switch (cluster) {
    case 'devnet':
      return 0;
    case 'mainnet-beta':
      return 1;
    case 'localnet':
      return 2;
    default:
      throw new Error(`Unsupported cluster: ${String(cluster)}`);
  }
}

function swapRouterToU8(router: number | SwapRouter): number {
  return typeof router === 'number' ? router : SWAP_ROUTER_TO_CODE[router as SwapRouter];
}

function swapSkipReasonToU8(reason: number | SwapSkipReason): number {
  return typeof reason === 'number' ? reason : SWAP_SKIP_REASON_TO_CODE[reason];
}

function resolveSwapSkipReason(input: AttestationInput): number {
  if (input.swapSkipReason !== undefined) return swapSkipReasonToU8(input.swapSkipReason);
  if (input.swapReasonCode !== undefined) {
    return input.swapReasonCode === 0 ? SWAP_SKIP_REASON_TO_CODE.NONE : SWAP_SKIP_REASON_TO_CODE.DUST;
  }
  return SWAP_SKIP_REASON_TO_CODE.NONE;
}

export function encodeAttestationPayload(input: AttestationInput): Uint8Array {
  const quoteQuotedAtUnixSec =
    input.quoteQuotedAtUnixSec !== undefined
      ? input.quoteQuotedAtUnixSec
      : input.quoteQuotedAtUnixMs !== undefined
        ? Math.floor(Number(input.quoteQuotedAtUnixMs) / 1000)
        : 0;
  const swapRouter = input.swapRouter ?? SWAP_ROUTER_TO_CODE.jupiter;
  return concat([
    u8(input.attestationVersion ?? ATTESTATION_VERSION),
    u8(clusterToU8(input.cluster)),
    toPubkey32(input.authority),
    toPubkey32(input.position),
    toPubkey32(input.positionMint),
    toPubkey32(input.whirlpool),
    u32le(input.epoch),
    u8(input.direction),
    i32le(input.tickCurrent),
    i32le(input.lowerTickIndex),
    i32le(input.upperTickIndex),
    u16le(input.slippageBpsCap),
    toPubkey32(input.quoteInputMint),
    toPubkey32(input.quoteOutputMint),
    u64le(input.quoteInAmount),
    u64le(input.quoteMinOutAmount),
    u32le(quoteQuotedAtUnixSec),
    u8(input.swapPlanned),
    u8(resolveSwapSkipReason(input)),
    u8(swapRouterToU8(swapRouter)),
  ]);
}

export function computeAttestationHash(input: AttestationInput): Uint8Array {
  return hashAttestationPayload(encodeAttestationPayload(input));
}
