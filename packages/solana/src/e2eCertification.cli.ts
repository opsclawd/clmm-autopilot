import { runCertificationSuite } from './e2eDevnet';

async function main(): Promise<void> {
  try {
    const artifacts = await runCertificationSuite(process.env);
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
