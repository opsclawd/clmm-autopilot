import { runMainnetShadow } from './mainnetShadow';

async function main(): Promise<void> {
  try {
    await runMainnetShadow(process.env);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'shadow.failed',
        code: e.code ?? 'UNKNOWN',
        message: e.message,
      }),
    );
    process.exit(1);
  }
}

void main();
