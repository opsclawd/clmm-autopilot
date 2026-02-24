import { DEFAULT_CONFIG, validateConfig, type AutopilotConfig, type ConfigError } from '@clmm-autopilot/core';

export type LoadedAutopilotConfig =
  | { ok: true; config: AutopilotConfig }
  | { ok: false; errors: ConfigError[]; config: AutopilotConfig };

function parseJsonConfig(raw: string | undefined): { ok: true; value: unknown } | { ok: false; error: ConfigError } {
  if (!raw) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      error: {
        path: 'NEXT_PUBLIC_AUTOPILOT_CONFIG',
        code: 'TYPE',
        message: 'Invalid JSON for NEXT_PUBLIC_AUTOPILOT_CONFIG',
        expected: 'valid JSON object',
        actual: raw,
      },
    };
  }
}

export function loadAutopilotConfig(env: Record<string, string | undefined> = process.env): LoadedAutopilotConfig {
  const parsed = parseJsonConfig(env.NEXT_PUBLIC_AUTOPILOT_CONFIG);
  if (!parsed.ok) return { ok: false, errors: [parsed.error], config: DEFAULT_CONFIG };

  const validated = validateConfig(parsed.value);
  if (validated.ok) return { ok: true, config: validated.value };
  return { ok: false, errors: validated.errors, config: DEFAULT_CONFIG };
}
