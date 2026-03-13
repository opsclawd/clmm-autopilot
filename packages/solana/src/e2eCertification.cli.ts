import { CERTIFICATION_SCENARIOS } from './e2e/scenarios';
import { runCertificationScenario, runCertificationSuite, type CertificationScenarioName } from './e2eDevnet';

function parseScenarioName(raw: string | undefined): CertificationScenarioName | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (CERTIFICATION_SCENARIOS.includes(value as CertificationScenarioName)) {
    return value as CertificationScenarioName;
  }
  throw new Error(`Unknown certification scenario '${value}'`);
}

async function main(): Promise<void> {
  try {
    const scenario = parseScenarioName(process.env.E2E_CERT_SCENARIO);
    const artifacts = scenario
      ? [await runCertificationScenario(scenario, process.env)]
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
