import type { CertificationFailurePhase } from '../executeOnce';
import type { CertificationStatus } from './resultArtifact';

export type CertificationDirection = 'DOWN' | 'UP';

export type CertificationScenarioId =
  | 'happy-path-execute'
  | 'hold-path-debounce'
  | 'stale-quote-rebuild'
  | 'signing-delay-blockhash-drift'
  | 'rpc-retry-exhaustion'
  | 'unsupported-router-cluster'
  | 'unsupported-swap-route'
  | 'insufficient-fee-buffer'
  | 'slippage-cap-breach'
  | 'duplicate-execution-same-epoch'
  | 'local-receipt-pending-blocker';

export type CertificationExecutionClass = 'pre_send_failure' | 'live_send_success' | 'live_send_failure';
export type CertificationFixtureShape = 'trigger_down' | 'trigger_up' | 'hold_in_range';

export type CertificationScenarioSpec = {
  key: string;
  id: CertificationScenarioId;
  direction: CertificationDirection;
  executionClass: CertificationExecutionClass;
  walletPromptExpected: boolean;
  freshFixtureRequired: boolean;
  fixtureShape: CertificationFixtureShape;
  expectedStatus: CertificationStatus;
  expectedErrorCodes: string[];
  expectedFailurePhase?: CertificationFailurePhase;
  requireQuoteRebuilt?: boolean;
  requireBlockhashRefreshed?: boolean;
  requireRetryExhaustionKey?: string;
};

type BaseScenario = Omit<CertificationScenarioSpec, 'key' | 'direction' | 'fixtureShape'> & {
  fixtureShapeByDirection?: Record<CertificationDirection, CertificationFixtureShape>;
};

const DIRECTIONS: CertificationDirection[] = ['DOWN', 'UP'];

const BASE_SCENARIOS: BaseScenario[] = [
  {
    id: 'happy-path-execute',
    executionClass: 'live_send_success',
    walletPromptExpected: true,
    freshFixtureRequired: true,
    expectedStatus: 'PASS',
    expectedErrorCodes: [],
  },
  {
    id: 'hold-path-debounce',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: false,
    expectedStatus: 'HOLD',
    expectedErrorCodes: [],
  },
  {
    id: 'stale-quote-rebuild',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: true,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['QUOTE_STALE'],
    expectedFailurePhase: 'quote',
  },
  {
    id: 'signing-delay-blockhash-drift',
    executionClass: 'live_send_success',
    walletPromptExpected: true,
    freshFixtureRequired: true,
    expectedStatus: 'PASS',
    expectedErrorCodes: [],
    requireBlockhashRefreshed: true,
  },
  {
    id: 'rpc-retry-exhaustion',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: true,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['RETRY_EXHAUSTED'],
    expectedFailurePhase: 'quote',
    requireRetryExhaustionKey: 'refreshPositionDecision',
  },
  {
    id: 'unsupported-router-cluster',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: true,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['SWAP_ROUTER_UNSUPPORTED_CLUSTER'],
    expectedFailurePhase: 'quote',
  },
  {
    id: 'unsupported-swap-route',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: true,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['UNSUPPORTED_SWAP_ROUTE'],
    expectedFailurePhase: 'quote',
  },
  {
    id: 'insufficient-fee-buffer',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: true,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['INSUFFICIENT_FEE_BUFFER'],
    expectedFailurePhase: 'build',
  },
  {
    id: 'slippage-cap-breach',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: true,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['SLIPPAGE_EXCEEDED'],
    expectedFailurePhase: 'build',
  },
  {
    id: 'duplicate-execution-same-epoch',
    executionClass: 'live_send_success',
    walletPromptExpected: true,
    freshFixtureRequired: true,
    expectedStatus: 'PASS',
    expectedErrorCodes: [],
  },
  {
    id: 'local-receipt-pending-blocker',
    executionClass: 'pre_send_failure',
    walletPromptExpected: false,
    freshFixtureRequired: false,
    expectedStatus: 'EXPECTED_FAILURE',
    expectedErrorCodes: ['LOCAL_RECEIPT_PENDING'],
    expectedFailurePhase: 'precheck',
  },
];

function defaultFixtureShape(direction: CertificationDirection, id: CertificationScenarioId): CertificationFixtureShape {
  if (id === 'hold-path-debounce') return 'hold_in_range';
  return direction === 'DOWN' ? 'trigger_down' : 'trigger_up';
}

function toSpec(direction: CertificationDirection, base: BaseScenario): CertificationScenarioSpec {
  return {
    ...base,
    direction,
    key: `${direction.toLowerCase()}-${base.id}`,
    fixtureShape: base.fixtureShapeByDirection?.[direction] ?? defaultFixtureShape(direction, base.id),
  };
}

export const CERTIFICATION_SCENARIOS: CertificationScenarioSpec[] = DIRECTIONS.flatMap((direction) =>
  BASE_SCENARIOS.map((base) => toSpec(direction, base)),
);

export function isCertificationScenarioId(value: string): value is CertificationScenarioId {
  return BASE_SCENARIOS.some((scenario) => scenario.id === value);
}

export function isCertificationDirection(value: string): value is CertificationDirection {
  return DIRECTIONS.includes(value as CertificationDirection);
}

export function resolveCertificationScenarios(filters?: {
  scenarioId?: CertificationScenarioId;
  direction?: CertificationDirection;
}): CertificationScenarioSpec[] {
  return CERTIFICATION_SCENARIOS.filter((scenario) => {
    if (filters?.scenarioId && scenario.id !== filters.scenarioId) return false;
    if (filters?.direction && scenario.direction !== filters.direction) return false;
    return true;
  });
}
