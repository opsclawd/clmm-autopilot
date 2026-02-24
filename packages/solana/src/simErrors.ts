import type { CanonicalErrorCode } from './types';

export type SimulationDiagnostics = {
  err: unknown | null;
  logs?: string[];
  unitsConsumed?: number;
  innerInstructions?: unknown;
  returnData?: unknown;
};

type Rule = {
  code: CanonicalErrorCode;
  message: string;
  patterns: string[];
};

const RULES: Rule[] = [
  {
    code: 'ALREADY_EXECUTED_THIS_EPOCH',
    message: 'Simulation failed because receipt already exists for epoch',
    patterns: ['already executed', 'receipt already exists', 'executionalreadyrecorded'],
  },
  {
    code: 'SLIPPAGE_EXCEEDED',
    message: 'Simulation failed due to slippage/minOut constraints',
    patterns: [
      'slippage',
      'min out',
      'output amount is too low',
      'insufficient output amount',
      '0x1771', // common aggregator custom error for slippage bounds
    ],
  },
  {
    code: 'INSUFFICIENT_FEE_BUFFER',
    message: 'Simulation failed due to insufficient funds/fees',
    patterns: [
      'insufficient funds',
      'insufficient lamports',
      'insufficient balance',
      'insufficient funds for fee',
      'custom program error: 0x1',
    ],
  },
  {
    code: 'DATA_UNAVAILABLE',
    message: 'Simulation failed due to missing account/ATA/route',
    patterns: [
      'account not found',
      'could not find account',
      'account does not exist',
      'ata missing',
      'route not found',
      'no route',
      'accountnotinitialized',
    ],
  },
  {
    code: 'INVALID_POSITION',
    message: 'Simulation failed due to invalid account owner/constraint',
    patterns: [
      'invalid account owner',
      'owner does not match',
      'constraintowner',
      'constraintseeds',
      'constraint',
      'invalidaccountdata',
      'incorrect program id',
    ],
  },
];

export function classifySimulationFailure(sim: SimulationDiagnostics): {
  code: CanonicalErrorCode;
  message: string;
  debug: SimulationDiagnostics;
} {
  const text = `${String(sim.err ?? '')}\n${(sim.logs ?? []).join('\n')}`.toLowerCase();

  const matched = RULES.find((r) => r.patterns.some((p) => text.includes(p)));
  if (matched) {
    return { code: matched.code, message: matched.message, debug: sim };
  }

  return { code: 'SIMULATION_FAILED', message: 'Simulation failed', debug: sim };
}
