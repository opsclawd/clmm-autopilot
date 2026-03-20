import {
  isCertificationDirection,
  isCertificationScenarioId,
  resolveCertificationScenarios,
  type CertificationDirection,
  type CertificationScenarioId,
} from './e2e/scenarios';
import { runCertificationScenario, runCertificationSuite } from './e2eDevnet';

function parseScenarioName(raw: string | undefined): CertificationScenarioId | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (isCertificationScenarioId(value)) {
    return value;
  }
  throw new Error(`Unknown certification scenario '${value}'`);
}

function parseDirection(raw: string | undefined): CertificationDirection | undefined {
  const value = raw?.trim().toUpperCase();
  if (!value) return undefined;
  if (isCertificationDirection(value)) return value;
  throw new Error(`Unknown certification direction '${raw}'`);
}

async function main(): Promise<void> {
  try {
    const scenario = parseScenarioName(process.env.E2E_CERT_SCENARIO);
    const direction = parseDirection(process.env.E2E_CERT_DIRECTION);
    const filtered = resolveCertificationScenarios({ scenarioId: scenario, direction });
    const artifacts = scenario || direction
      ? await Promise.all(filtered.map((entry) => runCertificationScenario(entry, process.env)))
      : await runCertificationSuite(process.env);
    const hasFail = artifacts.some((artifact) => artifact.status === 'FAIL');
    if (hasFail) {
      process.exit(1);
      return;
    }
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        step: 'certification.failed',
        code: e.code ?? 'UNKNOWN',
        message: e.message,
      }),
    );
    process.exit(1);
  }
}

void main();
