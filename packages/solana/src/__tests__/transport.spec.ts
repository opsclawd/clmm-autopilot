import { describe, expect, it } from 'vitest';
import { VersionedTransaction } from '@solana/web3.js';
import { createExecutionTransport, LiveSubmitter, ShadowSubmitter } from '../transport';

describe('execution transport', () => {
  it('ShadowSubmitter always throws EXECUTION_MODE_SEND_FORBIDDEN', async () => {
    const submitter = new ShadowSubmitter('mainnet-shadow');
    await expect(submitter.submit({} as VersionedTransaction)).rejects.toMatchObject({
      code: 'EXECUTION_MODE_SEND_FORBIDDEN',
    });
  });

  it('LiveSubmitter forwards submit to signAndSend', async () => {
    const submitter = new LiveSubmitter(async () => 'sig-123');
    await expect(submitter.submit({} as VersionedTransaction)).resolves.toBe('sig-123');
  });

  it('factory returns shadow submitter for mainnet-shadow without sign handler', async () => {
    const transport = createExecutionTransport({ executionMode: 'mainnet-shadow' });
    expect(transport.kind).toBe('shadow');
    await expect(transport.submit({} as VersionedTransaction)).rejects.toMatchObject({
      code: 'EXECUTION_MODE_SEND_FORBIDDEN',
    });
  });

  it('factory requires sign handler for non-shadow modes', () => {
    expect(() => createExecutionTransport({ executionMode: 'mainnet-live' })).toThrow(/signAndSend handler/);
  });
});
