import { createHash } from 'node:crypto';
import type { ExecutionMode } from '@clmm-autopilot/core';
import { initializeWalMode, openSqliteDatabase, resolveSqlitePath, type DatabaseSyncLike } from './sqlite';

export type LocalReceiptStatus = 'pending' | 'confirmed' | 'failed';
export type LocalReceiptDirection = 'UP' | 'DOWN';

export type LocalReceiptKey = {
  cluster: string;
  authority: string;
  positionMint: string;
  epoch: number;
};

export type LocalReceiptRow = LocalReceiptKey & {
  executionMode: ExecutionMode;
  positionAddress: string;
  whirlpoolAddress: string;
  direction: LocalReceiptDirection;
  attestationHash: string;
  attestationPayloadHash: string;
  status: LocalReceiptStatus;
  claimToken: string;
  claimedAt: number | null;
  confirmedAt: number | null;
  failedAt: number | null;
  txSignature: string | null;
  confirmedSlot: number | null;
  onChainReceiptEnabled: boolean;
  onChainReceiptPda: string | null;
  onChainReceiptVerified: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorDebugJson: string | null;
};

export type LocalReceiptInspectResult =
  | { kind: 'clear' }
  | { kind: 'blocked'; status: 'pending' | 'confirmed'; row: LocalReceiptRow };

export type LocalReceiptClaimParams = LocalReceiptKey & {
  executionMode: ExecutionMode;
  positionAddress: string;
  whirlpoolAddress: string;
  direction: LocalReceiptDirection;
  attestationHash: Uint8Array;
  attestationPayloadBytes: Uint8Array;
  claimToken: string;
  nowUnixMs: number;
  claimTtlMs: number;
  onChainReceiptEnabled: boolean;
  onChainReceiptPda?: string;
};

export type LocalReceiptClaimResult =
  | { kind: 'claimed'; row: LocalReceiptRow }
  | { kind: 'blocked'; status: 'pending' | 'confirmed'; row: LocalReceiptRow };

export type LocalReceiptConfirmParams = LocalReceiptKey & {
  claimToken: string;
  nowUnixMs: number;
  txSignature: string;
  confirmedSlot?: number;
  onChainReceiptPda?: string;
  onChainReceiptVerified: boolean;
};

export type LocalReceiptFailParams = LocalReceiptKey & {
  claimToken: string;
  nowUnixMs: number;
  errorCode: string;
  errorMessage: string;
  errorDebug?: unknown;
  txSignature?: string;
  onChainReceiptPda?: string;
};

export type LocalReceiptListFilters = {
  authority?: string;
  positionMint?: string;
  positionAddress?: string;
  epoch?: number;
  status?: LocalReceiptStatus;
};

export interface LocalReceiptLedger {
  readonly dbPath: string;
  inspect(key: LocalReceiptKey, nowUnixMs: number, claimTtlMs: number): LocalReceiptInspectResult;
  claim(params: LocalReceiptClaimParams): LocalReceiptClaimResult;
  confirm(params: LocalReceiptConfirmParams): LocalReceiptRow;
  fail(params: LocalReceiptFailParams): LocalReceiptRow;
  list(filters?: LocalReceiptListFilters): LocalReceiptRow[];
  close(): void;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function attestationPayloadHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function readBoolean(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}

function toRow(raw: Record<string, unknown>): LocalReceiptRow {
  return {
    cluster: String(raw.cluster),
    executionMode: String(raw.execution_mode) as ExecutionMode,
    authority: String(raw.authority),
    positionAddress: String(raw.position_address),
    positionMint: String(raw.position_mint),
    whirlpoolAddress: String(raw.whirlpool_address),
    epoch: Number(raw.epoch),
    direction: String(raw.direction) as LocalReceiptDirection,
    attestationHash: String(raw.attestation_hash),
    attestationPayloadHash: String(raw.attestation_payload_hash),
    status: String(raw.status) as LocalReceiptStatus,
    claimToken: String(raw.claim_token),
    claimedAt: nullableNumber(raw.claimed_at_unix_ms),
    confirmedAt: nullableNumber(raw.confirmed_at_unix_ms),
    failedAt: nullableNumber(raw.failed_at_unix_ms),
    txSignature: raw.tx_signature === null ? null : String(raw.tx_signature),
    confirmedSlot: nullableNumber(raw.confirmed_slot),
    onChainReceiptEnabled: readBoolean(raw.on_chain_receipt_enabled),
    onChainReceiptPda: raw.on_chain_receipt_pda === null ? null : String(raw.on_chain_receipt_pda),
    onChainReceiptVerified: readBoolean(raw.on_chain_receipt_verified),
    lastErrorCode: raw.last_error_code === null ? null : String(raw.last_error_code),
    lastErrorMessage: raw.last_error_message === null ? null : String(raw.last_error_message),
    lastErrorDebugJson: raw.last_error_debug_json === null ? null : String(raw.last_error_debug_json),
  };
}

function ensureRow<T>(value: T | undefined | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export class SqliteLocalReceiptLedger implements LocalReceiptLedger {
  readonly dbPath: string;
  private readonly db: DatabaseSyncLike;

  constructor(dbPath: string) {
    this.dbPath = resolveSqlitePath(dbPath);
    this.db = openSqliteDatabase(dbPath);
    initializeWalMode(this.db);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        authority TEXT NOT NULL,
        position_address TEXT NOT NULL,
        position_mint TEXT NOT NULL,
        whirlpool_address TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        direction TEXT NOT NULL,
        attestation_hash TEXT NOT NULL,
        attestation_payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at_unix_ms INTEGER,
        confirmed_at_unix_ms INTEGER,
        failed_at_unix_ms INTEGER,
        tx_signature TEXT,
        confirmed_slot INTEGER,
        on_chain_receipt_enabled INTEGER NOT NULL,
        on_chain_receipt_pda TEXT,
        on_chain_receipt_verified INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_error_message TEXT,
        last_error_debug_json TEXT,
        UNIQUE (cluster, authority, position_mint, epoch)
      );
    `);
  }

  inspect(key: LocalReceiptKey, nowUnixMs: number, claimTtlMs: number): LocalReceiptInspectResult {
    const row = this.fetchByKey(key);
    if (!row) return { kind: 'clear' };
    if (row.status === 'confirmed') {
      return { kind: 'blocked', status: 'confirmed', row };
    }
    if (row.status === 'pending' && row.claimedAt !== null && row.claimedAt + claimTtlMs > nowUnixMs) {
      return { kind: 'blocked', status: 'pending', row };
    }
    return { kind: 'clear' };
  }

  claim(params: LocalReceiptClaimParams): LocalReceiptClaimResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.fetchByKey(params);
      if (existing) {
        if (existing.status === 'confirmed') {
          this.db.exec('ROLLBACK');
          return { kind: 'blocked', status: 'confirmed', row: existing };
        }
        const stalePending =
          existing.status === 'pending' &&
          existing.claimedAt !== null &&
          existing.claimedAt + params.claimTtlMs <= params.nowUnixMs;
        if (existing.status === 'pending' && !stalePending) {
          this.db.exec('ROLLBACK');
          return { kind: 'blocked', status: 'pending', row: existing };
        }

        this.db
          .prepare(
            `UPDATE local_receipts
             SET execution_mode = ?,
                 position_address = ?,
                 whirlpool_address = ?,
                 direction = ?,
                 attestation_hash = ?,
                 attestation_payload_hash = ?,
                 status = 'pending',
                 claim_token = ?,
                 claimed_at_unix_ms = ?,
                 confirmed_at_unix_ms = NULL,
                 failed_at_unix_ms = NULL,
                 tx_signature = NULL,
                 confirmed_slot = NULL,
                 on_chain_receipt_enabled = ?,
                 on_chain_receipt_pda = ?,
                 on_chain_receipt_verified = 0,
                 last_error_code = NULL,
                 last_error_message = NULL,
                 last_error_debug_json = NULL
             WHERE cluster = ? AND authority = ? AND position_mint = ? AND epoch = ?`,
          )
          .run(
            params.executionMode,
            params.positionAddress,
            params.whirlpoolAddress,
            params.direction,
            bytesToHex(params.attestationHash),
            attestationPayloadHash(params.attestationPayloadBytes),
            params.claimToken,
            params.nowUnixMs,
            boolToInt(params.onChainReceiptEnabled),
            params.onChainReceiptPda ?? null,
            params.cluster,
            params.authority,
            params.positionMint,
            params.epoch,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO local_receipts (
              cluster, execution_mode, authority, position_address, position_mint, whirlpool_address, epoch,
              direction, attestation_hash, attestation_payload_hash, status, claim_token, claimed_at_unix_ms,
              on_chain_receipt_enabled, on_chain_receipt_pda, on_chain_receipt_verified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0)`,
          )
          .run(
            params.cluster,
            params.executionMode,
            params.authority,
            params.positionAddress,
            params.positionMint,
            params.whirlpoolAddress,
            params.epoch,
            params.direction,
            bytesToHex(params.attestationHash),
            attestationPayloadHash(params.attestationPayloadBytes),
            params.claimToken,
            params.nowUnixMs,
            boolToInt(params.onChainReceiptEnabled),
            params.onChainReceiptPda ?? null,
          );
      }

      const claimed = ensureRow(this.fetchByKey(params), 'local receipt claim missing after write');
      this.db.exec('COMMIT');
      return { kind: 'claimed', row: claimed };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  confirm(params: LocalReceiptConfirmParams): LocalReceiptRow {
    this.db
      .prepare(
        `UPDATE local_receipts
         SET status = 'confirmed',
             confirmed_at_unix_ms = ?,
             failed_at_unix_ms = NULL,
             tx_signature = ?,
             confirmed_slot = ?,
             on_chain_receipt_pda = COALESCE(?, on_chain_receipt_pda),
             on_chain_receipt_verified = ?,
             last_error_code = NULL,
             last_error_message = NULL,
             last_error_debug_json = NULL
         WHERE cluster = ? AND authority = ? AND position_mint = ? AND epoch = ? AND claim_token = ?`,
      )
      .run(
        params.nowUnixMs,
        params.txSignature,
        params.confirmedSlot ?? null,
        params.onChainReceiptPda ?? null,
        boolToInt(params.onChainReceiptVerified),
        params.cluster,
        params.authority,
        params.positionMint,
        params.epoch,
        params.claimToken,
      );
    return ensureRow(
      this.fetchByClaim(params, params.claimToken),
      'local receipt confirmation failed because the active claim token no longer owns the row',
    );
  }

  fail(params: LocalReceiptFailParams): LocalReceiptRow {
    this.db
      .prepare(
        `UPDATE local_receipts
         SET status = 'failed',
             failed_at_unix_ms = ?,
             tx_signature = COALESCE(?, tx_signature),
             on_chain_receipt_pda = COALESCE(?, on_chain_receipt_pda),
             on_chain_receipt_verified = 0,
             last_error_code = ?,
             last_error_message = ?,
             last_error_debug_json = ?
         WHERE cluster = ? AND authority = ? AND position_mint = ? AND epoch = ? AND claim_token = ?`,
      )
      .run(
        params.nowUnixMs,
        params.txSignature ?? null,
        params.onChainReceiptPda ?? null,
        params.errorCode,
        params.errorMessage,
        params.errorDebug === undefined ? null : JSON.stringify(params.errorDebug),
        params.cluster,
        params.authority,
        params.positionMint,
        params.epoch,
        params.claimToken,
      );
    return ensureRow(
      this.fetchByClaim(params, params.claimToken),
      'local receipt failure update failed because the active claim token no longer owns the row',
    );
  }

  list(filters: LocalReceiptListFilters = {}): LocalReceiptRow[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filters.authority) {
      clauses.push('authority = ?');
      values.push(filters.authority);
    }
    if (filters.positionMint) {
      clauses.push('position_mint = ?');
      values.push(filters.positionMint);
    }
    if (filters.positionAddress) {
      clauses.push('position_address = ?');
      values.push(filters.positionAddress);
    }
    if (filters.epoch !== undefined) {
      clauses.push('epoch = ?');
      values.push(filters.epoch);
    }
    if (filters.status) {
      clauses.push('status = ?');
      values.push(filters.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT
            cluster, execution_mode, authority, position_address, position_mint, whirlpool_address, epoch,
            direction, attestation_hash, attestation_payload_hash, status, claim_token, claimed_at_unix_ms,
            confirmed_at_unix_ms, failed_at_unix_ms, tx_signature, confirmed_slot, on_chain_receipt_enabled,
            on_chain_receipt_pda, on_chain_receipt_verified, last_error_code, last_error_message, last_error_debug_json
         FROM local_receipts
         ${where}
         ORDER BY epoch DESC, authority ASC, position_mint ASC`,
      )
      .all(...values)
      .map((row) => toRow(row as Record<string, unknown>));
  }

  close(): void {
    this.db.close();
  }

  private fetchByKey(key: LocalReceiptKey): LocalReceiptRow | null {
    const row = this.db
      .prepare(
        `SELECT
            cluster, execution_mode, authority, position_address, position_mint, whirlpool_address, epoch,
            direction, attestation_hash, attestation_payload_hash, status, claim_token, claimed_at_unix_ms,
            confirmed_at_unix_ms, failed_at_unix_ms, tx_signature, confirmed_slot, on_chain_receipt_enabled,
            on_chain_receipt_pda, on_chain_receipt_verified, last_error_code, last_error_message, last_error_debug_json
         FROM local_receipts
         WHERE cluster = ? AND authority = ? AND position_mint = ? AND epoch = ?`,
      )
      .get(key.cluster, key.authority, key.positionMint, key.epoch) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  private fetchByClaim(key: LocalReceiptKey, claimToken: string): LocalReceiptRow | null {
    const row = this.db
      .prepare(
        `SELECT
            cluster, execution_mode, authority, position_address, position_mint, whirlpool_address, epoch,
            direction, attestation_hash, attestation_payload_hash, status, claim_token, claimed_at_unix_ms,
            confirmed_at_unix_ms, failed_at_unix_ms, tx_signature, confirmed_slot, on_chain_receipt_enabled,
            on_chain_receipt_pda, on_chain_receipt_verified, last_error_code, last_error_message, last_error_debug_json
         FROM local_receipts
         WHERE cluster = ? AND authority = ? AND position_mint = ? AND epoch = ? AND claim_token = ?`,
      )
      .get(key.cluster, key.authority, key.positionMint, key.epoch, claimToken) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }
}

export function createSqliteLocalReceiptLedger(dbPath: string): LocalReceiptLedger {
  return new SqliteLocalReceiptLedger(dbPath);
}
