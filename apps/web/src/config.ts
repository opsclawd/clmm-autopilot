import { DEFAULT_CONFIG, validateConfig, type AutopilotConfig, type ConfigError } from '@clmm-autopilot/core';

export type LoadedAutopilotConfig =
  | { ok: true; config: AutopilotConfig }
  | { ok: false; errors: ConfigError[]; config: AutopilotConfig };

function parseJsonConfig(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: true };
  }
}

export function loadAutopilotConfig(env: Record<string, string | undefined> = process.env): LoadedAutopilotConfig {
  const raw = env.NEXT_PUBLIC_AUTOPILOT_CONFIG;
  const parsed = parseJsonConfig(raw);
  const validated = validateConfig(parsed);
  if (validated.ok) return { ok: true, config: validated.value };
  return { ok: false, errors: validated.errors, config: DEFAULT_CONFIG };
}
