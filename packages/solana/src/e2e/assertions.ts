import type { AssertionResult } from './resultArtifact';

export type AssertionInput = {
  name: string;
  pass: boolean;
  actual: unknown;
  expected: unknown;
  reasonCode?: string;
  detail?: string;
};

export const REQUIRED_ASSERTION_NAMES = [
  'precheck.receiptAbsent',
  'decision.isExpected',
  'scenario.statusMatchesExpected',
  'scenario.quoteRebuilt',
  'scenario.blockhashRefreshed',
  'scenario.retryExhausted',
  'tx.buildSucceeded',
  'tx.simulationSucceeded',
  'tx.confirmed',
  'tx.notBuilt',
  'receipt.notAttempted',
  'post.receiptPresent',
  'post.liquidityZero',
  'post.feesCollected',
  'post.balanceDeltaValid',
  'post.swapExecutedOrValidlySkipped',
  'post.duplicateBlocked',
  'error.matchesExpected',
] as const;

export function makeAssertion(input: AssertionInput): AssertionResult {
  return {
    name: input.name,
    pass: input.pass,
    actual: input.actual,
    expected: input.expected,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export function allAssertionsPass(assertions: AssertionResult[]): boolean {
  return assertions.every((entry) => entry.pass);
}

export function getAssertion(assertions: AssertionResult[], name: string): AssertionResult | undefined {
  return assertions.find((entry) => entry.name === name);
}
