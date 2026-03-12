import type { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants';
import type { CanonicalErrorCode } from '../types';

type TypedError = Error & { code: CanonicalErrorCode; retryable: boolean; debug?: unknown };

export type TokenProgramInfo = {
  tokenProgramId: PublicKey;
  isToken2022: boolean;
  mintPubkey: PublicKey;
};

type ReadonlyConnection = Pick<Connection, 'getAccountInfo'>;

const TOKEN_PROGRAM_CACHE_MAX_ENTRIES = 512;
const tokenProgramResolverCache = new Map<string, TokenProgramInfo>();

function fail(code: CanonicalErrorCode, message: string, retryable: boolean, debug?: unknown): never {
  const err = new Error(message) as TypedError;
  err.code = code;
  err.retryable = retryable;
  if (debug !== undefined) err.debug = debug;
  throw err;
}

function cacheSet(key: string, value: TokenProgramInfo): void {
  if (tokenProgramResolverCache.has(key)) tokenProgramResolverCache.delete(key);
  tokenProgramResolverCache.set(key, value);
  if (tokenProgramResolverCache.size <= TOKEN_PROGRAM_CACHE_MAX_ENTRIES) return;
  const oldest = tokenProgramResolverCache.keys().next().value;
  if (oldest) tokenProgramResolverCache.delete(oldest);
}

function cacheGet(key: string): TokenProgramInfo | undefined {
  const value = tokenProgramResolverCache.get(key);
  if (!value) return undefined;
  tokenProgramResolverCache.delete(key);
  tokenProgramResolverCache.set(key, value);
  return value;
}

export function tokenProgramInfoFromMintOwner(mintPubkey: PublicKey, owner: PublicKey): TokenProgramInfo {
  if (owner.equals(TOKEN_PROGRAM_ID)) {
    return {
      tokenProgramId: TOKEN_PROGRAM_ID,
      isToken2022: false,
      mintPubkey,
    };
  }
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return {
      tokenProgramId: TOKEN_2022_PROGRAM_ID,
      isToken2022: true,
      mintPubkey,
    };
  }
  fail('UNSUPPORTED_MINT_OWNER', 'Mint account owner is not a supported SPL token program', false, {
    mint: mintPubkey.toBase58(),
    owner: owner.toBase58(),
    supportedOwners: [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()],
  });
}

export async function resolveTokenProgramForMint(connection: ReadonlyConnection, mintPubkey: PublicKey): Promise<TokenProgramInfo> {
  const cacheKey = mintPubkey.toBase58();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const mintAccount = await connection.getAccountInfo(mintPubkey, 'confirmed');
  if (!mintAccount) {
    fail('DATA_UNAVAILABLE', 'mint account unavailable', false, { mint: cacheKey });
  }

  const info = tokenProgramInfoFromMintOwner(mintPubkey, mintAccount.owner);
  cacheSet(cacheKey, info);
  return info;
}

export function __clearTokenProgramResolverCacheForTests(): void {
  tokenProgramResolverCache.clear();
}

export function __tokenProgramResolverCacheSizeForTests(): number {
  return tokenProgramResolverCache.size;
}
