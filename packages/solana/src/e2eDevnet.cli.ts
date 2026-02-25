import { runDevnetE2E } from './e2eDevnet';

async function main(): Promise<void> {
  try {
    await runDevnetE2E(process.env);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        step: 'harness.failed',
        code: e.code ?? 'UNKNOWN',
        message: e.message,
      }),
    );
    process.exit(1);
  }
}

void main();
