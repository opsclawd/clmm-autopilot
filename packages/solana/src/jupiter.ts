import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';

export type JupiterQuote = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps: number;
  quotedAtUnixMs: number;
  raw: unknown;
};

export type JupiterSwapIxs = {
  instructions: TransactionInstruction[];
  lookupTableAddresses: PublicKey[];
};

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
}>;

const DEFAULT_BASE = 'https://quote-api.jup.ag/v6';
// Milestone-deferred flag: keep enabled until Jupiter integration hardening milestone.
const JUPITER_SWAP_DISABLED_FOR_TESTING = true;

function asPk(s: string): PublicKey {
  return new PublicKey(s);
}

function decodeIx(ix: any): TransactionInstruction {
  const programId = asPk(ix.programId);
  const keys: AccountMeta[] = (ix.accounts ?? []).map((a: any) => ({
    pubkey: asPk(a.pubkey),
    isSigner: Boolean(a.isSigner),
    isWritable: Boolean(a.isWritable),
  }));
  const data = Buffer.from(ix.data, 'base64');
  return new TransactionInstruction({ programId, keys, data });
}

export async function fetchJupiterQuote(params: {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  slippageBps: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  nowUnixMs?: () => number;
}): Promise<JupiterQuote> {
  if (JUPITER_SWAP_DISABLED_FOR_TESTING) {
    // Temporary bypass: synthesize a quote so the rest of the workflow can be tested offline.
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amount,
      outAmount: BigInt(0),
      slippageBps: params.slippageBps,
      quotedAtUnixMs: (params.nowUnixMs ?? (() => Date.now()))(),
      raw: { disabled: true, reason: 'JUPITER_SWAP_DISABLED_FOR_TESTING' },
    };
  }

  const baseUrl = params.baseUrl ?? DEFAULT_BASE;
  const fetchImpl: FetchLike = params.fetchImpl ?? (globalThis.fetch as any);
  if (!fetchImpl) throw new Error('fetch is not available (provide fetchImpl)');

  const url = new URL(`${baseUrl}/quote`);
  url.searchParams.set('inputMint', params.inputMint.toBase58());
  url.searchParams.set('outputMint', params.outputMint.toBase58());
  url.searchParams.set('amount', params.amount.toString());
  url.searchParams.set('slippageBps', params.slippageBps.toString());
  url.searchParams.set('onlyDirectRoutes', 'false');

  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }

  const raw = await res.json();
  return {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmount: BigInt(raw.inAmount ?? params.amount.toString()),
    outAmount: BigInt(raw.outAmount ?? '0'),
    slippageBps: params.slippageBps,
    quotedAtUnixMs: (params.nowUnixMs ?? (() => Date.now()))(),
    raw,
  };
}

export async function fetchJupiterSwapIxs(params: {
  quote: JupiterQuote;
  userPublicKey: PublicKey;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  wrapAndUnwrapSol?: boolean;
}): Promise<JupiterSwapIxs> {
  if (JUPITER_SWAP_DISABLED_FOR_TESTING) {
    // Temporary bypass: keep the exit workflow testable while Jupiter swap-instructions is failing.
    return { instructions: [], lookupTableAddresses: [] };
  }

  const baseUrl = params.baseUrl ?? DEFAULT_BASE;
  const fetchImpl: FetchLike = params.fetchImpl ?? (globalThis.fetch as any);
  if (!fetchImpl) throw new Error('fetch is not available (provide fetchImpl)');

  const body = {
    quoteResponse: params.quote.raw,
    userPublicKey: params.userPublicKey.toBase58(),
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? false,
    asLegacyTransaction: false,
  };

  const res = await fetchImpl(`${baseUrl}/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Jupiter swap-instructions failed: ${res.status} ${await res.text()}`);
  }

  const raw = await res.json();
  const ixs: TransactionInstruction[] = [];
  for (const ix of raw.computeBudgetInstructions ?? []) ixs.push(decodeIx(ix));
  for (const ix of raw.setupInstructions ?? []) ixs.push(decodeIx(ix));
  if (raw.swapInstruction) ixs.push(decodeIx(raw.swapInstruction));
  for (const ix of raw.cleanupInstruction ? [raw.cleanupInstruction] : []) ixs.push(decodeIx(ix));
  for (const ix of raw.otherInstructions ?? []) ixs.push(decodeIx(ix));

  const lookupTableAddresses = (raw.addressLookupTableAddresses ?? []).map((s: string) => asPk(s));
  return { instructions: ixs, lookupTableAddresses };
}
