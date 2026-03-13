import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { CanonicalErrorCode, ShadowSimulationClass } from '../types';

const require = createRequire(import.meta.url);

type DatabaseSyncLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...args: any[]) => void;
    get: (...args: any[]) => any;
  };
  close: () => void;
};

function openSqlite(path: string): DatabaseSyncLike {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseSyncLike };
  return new sqlite.DatabaseSync(path);
}

export type PositionSourceMode = 'configured' | 'discovered';

export type ShadowEvaluationRecord = {
  sessionId: string;
  timestamp: string;
  cluster: string;
  executionMode: string;
  positionAddress: string;
  authority: string;
  whirlpoolAddress: string;
  decision: string;
  reasonCode: string;
  debounceCount: number;
  stateColdStart: boolean;
  sampledCheckpoint: boolean;
  positionSourceMode: PositionSourceMode;
};

export type ShadowTriggerRecord = {
  sessionId: string;
  timestamp: string;
  cluster: string;
  executionMode: string;
  positionAddress: string;
  authority: string;
  whirlpoolAddress: string;
  direction: 'trigger_up' | 'trigger_down';
  currentTick: number;
  lowerTick: number;
  upperTick: number;
  debounceCount: number;
  swapRouter: string;
  quoteInAmount: string;
  quoteMinOut: string;
  slippageBps: number;
  quoteAgeMs: number;
  txBuildStatus: 'BUILD_OK' | 'BUILD_FAILED';
  simulationStatus: ShadowSimulationClass;
  simulationErrorCode?: CanonicalErrorCode;
  candidateInstructionSummaryJson: string;
  wouldExecute: boolean;
  wouldFailReason?: string;
  receiptPdaExpected?: string;
  receiptConfigValid: boolean;
  receiptStepStructurallyBuildable: boolean;
  receiptIxIncluded: boolean;
  mintAProgram: string;
  mintBProgram: string;
  positionSourceMode: PositionSourceMode;
};

export type ShadowMetricsRollupRecord = {
  sessionId: string;
  timestamp: string;
  monitoredEvaluations: number;
  triggersFired: number;
  triggersSuppressedByDebounce: number;
  candidateTxBuildAttempts: number;
  successfulSimulations: number;
  failedSimulationsByClassJson: string;
  averageQuoteAgeMs: number;
  averageTriggerDelayMs: number;
  triggerUpCount: number;
  triggerDownCount: number;
  signerInvocations: number;
  submitInvocations: number;
  walletPromptCount: number;
  shadowTxSignaturesEmitted: number;
};

export class ShadowArtifactStore {
  readonly dbPath: string;
  private readonly db: DatabaseSyncLike;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = openSqlite(this.dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS run_sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        state_cold_start INTEGER NOT NULL,
        position_source_mode TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shadow_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        cluster TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        position_address TEXT NOT NULL,
        authority TEXT NOT NULL,
        whirlpool_address TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        debounce_count INTEGER NOT NULL,
        state_cold_start INTEGER NOT NULL,
        sampled_checkpoint INTEGER NOT NULL,
        position_source_mode TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shadow_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        cluster TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        position_address TEXT NOT NULL,
        authority TEXT NOT NULL,
        whirlpool_address TEXT NOT NULL,
        direction TEXT NOT NULL,
        current_tick INTEGER NOT NULL,
        lower_tick INTEGER NOT NULL,
        upper_tick INTEGER NOT NULL,
        debounce_count INTEGER NOT NULL,
        swap_router TEXT NOT NULL,
        quote_in_amount TEXT NOT NULL,
        quote_min_out TEXT NOT NULL,
        slippage_bps INTEGER NOT NULL,
        quote_age_ms INTEGER NOT NULL,
        tx_build_status TEXT NOT NULL,
        simulation_status TEXT NOT NULL,
        simulation_error_code TEXT,
        candidate_instruction_summary_json TEXT NOT NULL,
        would_execute INTEGER NOT NULL,
        would_fail_reason TEXT,
        receipt_pda_expected TEXT,
        receipt_config_valid INTEGER NOT NULL,
        receipt_step_structurally_buildable INTEGER NOT NULL,
        receipt_ix_included INTEGER NOT NULL,
        mint_a_program TEXT NOT NULL,
        mint_b_program TEXT NOT NULL,
        position_source_mode TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shadow_metrics_rollups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        monitored_evaluations INTEGER NOT NULL,
        triggers_fired INTEGER NOT NULL,
        triggers_suppressed_by_debounce INTEGER NOT NULL,
        candidate_tx_build_attempts INTEGER NOT NULL,
        successful_simulations INTEGER NOT NULL,
        failed_simulations_by_class_json TEXT NOT NULL,
        average_quote_age_ms REAL NOT NULL,
        average_trigger_delay_ms REAL NOT NULL,
        trigger_up_count INTEGER NOT NULL,
        trigger_down_count INTEGER NOT NULL,
        signer_invocations INTEGER NOT NULL,
        submit_invocations INTEGER NOT NULL,
        wallet_prompt_count INTEGER NOT NULL,
        shadow_tx_signatures_emitted INTEGER NOT NULL
      );
    `);
  }

  insertRunSession(params: {
    sessionId: string;
    startedAt: string;
    stateColdStart: boolean;
    positionSourceMode: PositionSourceMode;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_sessions (session_id, started_at, state_cold_start, position_source_mode)
         VALUES (?, ?, ?, ?)`,
      )
      .run(params.sessionId, params.startedAt, params.stateColdStart ? 1 : 0, params.positionSourceMode);
  }

  insertEvaluation(record: ShadowEvaluationRecord): void {
    this.db
      .prepare(
        `INSERT INTO shadow_evaluations (
          session_id, timestamp, cluster, execution_mode, position_address, authority, whirlpool_address,
          decision, reason_code, debounce_count, state_cold_start, sampled_checkpoint, position_source_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionId,
        record.timestamp,
        record.cluster,
        record.executionMode,
        record.positionAddress,
        record.authority,
        record.whirlpoolAddress,
        record.decision,
        record.reasonCode,
        record.debounceCount,
        record.stateColdStart ? 1 : 0,
        record.sampledCheckpoint ? 1 : 0,
        record.positionSourceMode,
      );
  }

  insertTrigger(record: ShadowTriggerRecord): void {
    this.db
      .prepare(
        `INSERT INTO shadow_triggers (
          session_id, timestamp, cluster, execution_mode, position_address, authority, whirlpool_address,
          direction, current_tick, lower_tick, upper_tick, debounce_count, swap_router,
          quote_in_amount, quote_min_out, slippage_bps, quote_age_ms,
          tx_build_status, simulation_status, simulation_error_code,
          candidate_instruction_summary_json, would_execute, would_fail_reason,
          receipt_pda_expected, receipt_config_valid, receipt_step_structurally_buildable,
          receipt_ix_included, mint_a_program, mint_b_program, position_source_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionId,
        record.timestamp,
        record.cluster,
        record.executionMode,
        record.positionAddress,
        record.authority,
        record.whirlpoolAddress,
        record.direction,
        record.currentTick,
        record.lowerTick,
        record.upperTick,
        record.debounceCount,
        record.swapRouter,
        record.quoteInAmount,
        record.quoteMinOut,
        record.slippageBps,
        record.quoteAgeMs,
        record.txBuildStatus,
        record.simulationStatus,
        record.simulationErrorCode ?? null,
        record.candidateInstructionSummaryJson,
        record.wouldExecute ? 1 : 0,
        record.wouldFailReason ?? null,
        record.receiptPdaExpected ?? null,
        record.receiptConfigValid ? 1 : 0,
        record.receiptStepStructurallyBuildable ? 1 : 0,
        record.receiptIxIncluded ? 1 : 0,
        record.mintAProgram,
        record.mintBProgram,
        record.positionSourceMode,
      );
  }

  insertRollup(record: ShadowMetricsRollupRecord): void {
    this.db
      .prepare(
        `INSERT INTO shadow_metrics_rollups (
          session_id, timestamp, monitored_evaluations, triggers_fired, triggers_suppressed_by_debounce,
          candidate_tx_build_attempts, successful_simulations, failed_simulations_by_class_json,
          average_quote_age_ms, average_trigger_delay_ms, trigger_up_count, trigger_down_count,
          signer_invocations, submit_invocations, wallet_prompt_count, shadow_tx_signatures_emitted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionId,
        record.timestamp,
        record.monitoredEvaluations,
        record.triggersFired,
        record.triggersSuppressedByDebounce,
        record.candidateTxBuildAttempts,
        record.successfulSimulations,
        record.failedSimulationsByClassJson,
        record.averageQuoteAgeMs,
        record.averageTriggerDelayMs,
        record.triggerUpCount,
        record.triggerDownCount,
        record.signerInvocations,
        record.submitInvocations,
        record.walletPromptCount,
        record.shadowTxSignaturesEmitted,
      );
  }

  close(): void {
    this.db.close();
  }
}
