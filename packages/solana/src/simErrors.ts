import type { CanonicalErrorCode } from './types';

export type SimulationDiagnostics = {
  err: unknown | null;
  logs?: string[];
  unitsConsumed?: number;
  innerInstructions?: unknown;
  returnData?: unknown;
};

export function classifySimulationFailure(sim: SimulationDiagnostics): {
  code: CanonicalErrorCode;
  message: string;
  debug: SimulationDiagnostics;
} {
  const text = `${String(sim.err ?? '')}\n${(sim.logs ?? []).join('\n')}`.toLowerCase();

  let code: CanonicalErrorCode = 'SIMULATION_FAILED';
  let message = 'Simulation failed';

  if (text.includes('slippage') || text.includes('min out')) {
    code = 'SLIPPAGE_EXCEEDED';
    message = 'Simulation failed due to slippage/minOut constraints';
  } else if (text.includes('insufficient funds') || text.includes('insufficient lamports')) {
    code = 'INSUFFICIENT_FEE_BUFFER';
    message = 'Simulation failed due to insufficient funds';
  } else if (
    text.includes('account not found') ||
    text.includes('could not find account') ||
    text.includes('ata') && text.includes('missing')
  ) {
    code = 'DATA_UNAVAILABLE';
    message = 'Simulation failed due to missing account/ATA';
  } else if (
    text.includes('invalid account owner') ||
    text.includes('owner does not match') ||
    text.includes('constraint')
  ) {
    code = 'INVALID_POSITION';
    message = 'Simulation failed due to invalid account owner/constraint';
  } else if (text.includes('already executed') || text.includes('receipt already exists')) {
    code = 'ALREADY_EXECUTED_THIS_EPOCH';
    message = 'Simulation failed because receipt already exists for epoch';
  }

  return { code, message, debug: sim };
}
