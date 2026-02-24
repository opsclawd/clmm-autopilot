import { describe, expect, it } from 'vitest';
import { classifySimulationFailure } from '../simErrors';

describe('classifySimulationFailure', () => {
  it('maps missing account to DATA_UNAVAILABLE', () => {
    const out = classifySimulationFailure({ err: 'AccountNotFound', logs: ['could not find account'] });
    expect(out.code).toBe('DATA_UNAVAILABLE');
  });

  it('maps Anchor receipt duplicate error to ALREADY_EXECUTED_THIS_EPOCH', () => {
    const out = classifySimulationFailure({ err: 'custom', logs: ['ExecutionAlreadyRecorded'] });
    expect(out.code).toBe('ALREADY_EXECUTED_THIS_EPOCH');
  });

  it('maps invalid owner/constraint to INVALID_POSITION', () => {
    const out = classifySimulationFailure({ err: 'custom', logs: ['ConstraintOwner'] });
    expect(out.code).toBe('INVALID_POSITION');
  });

  it('maps jupiter/orca slippage signatures to SLIPPAGE_EXCEEDED', () => {
    expect(classifySimulationFailure({ err: 'custom program error: 0x1771', logs: [] }).code).toBe('SLIPPAGE_EXCEEDED');
    expect(classifySimulationFailure({ err: 'insufficient output amount', logs: [] }).code).toBe('SLIPPAGE_EXCEEDED');
  });

  it('maps insufficient funds signatures to INSUFFICIENT_FEE_BUFFER', () => {
    const out = classifySimulationFailure({ err: 'insufficient funds for fee', logs: [] });
    expect(out.code).toBe('INSUFFICIENT_FEE_BUFFER');
  });

  it('preserves logs in debug payload', () => {
    const out = classifySimulationFailure({ err: 'AccountNotFound', logs: ['L1', 'L2'] });
    expect(out.debug.logs).toEqual(['L1', 'L2']);
  });
});
