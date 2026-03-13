import type { CertificationScenarioName } from '../e2eDevnet';

export const CERTIFICATION_SCENARIOS: CertificationScenarioName[] = [
  'happy-path-trigger',
  'hold-path',
  'stale-quote-rebuild',
  'signing-delay-blockhash-drift',
  'rpc-retry-exhaustion',
  'unsupported-router-cluster',
  'receipt-misconfiguration',
  'token2022-certification',
  'duplicate-execution-same-epoch',
];
