import { DEFAULT_CONFIG, validateConfig, type AutopilotConfig, type ConfigError } from '@clmm-autopilot/core';
import Constants from 'expo-constants';

export type LoadedAutopilotConfig =
  | { ok: true; config: AutopilotConfig }
  | { ok: false; errors: ConfigError[]; config: AutopilotConfig };

export function loadAutopilotConfig(): LoadedAutopilotConfig {
  const extra = (Constants.expoConfig as any)?.extra as Record<string, unknown> | undefined;
  const candidate = extra?.AUTOPILOT_CONFIG ?? extra?.autopilotConfig;

  const parsed =
    typeof candidate === 'string'
      ? (() => {
          try {
            return { ok: true as const, value: JSON.parse(candidate) };
          } catch {
            return {
              ok: false as const,
              error: {
                path: 'expo.extra.AUTOPILOT_CONFIG',
                code: 'TYPE' as const,
                message: 'Invalid JSON for mobile AUTOPILOT_CONFIG',
                expected: 'valid JSON object',
                actual: candidate,
              },
            };
          }
        })()
      : ({ ok: true as const, value: candidate });

  if (!parsed.ok) return { ok: false, errors: [parsed.error], config: DEFAULT_CONFIG };

  const validated = validateConfig(parsed.value);
  if (validated.ok) return { ok: true, config: validated.value };
  return { ok: false, errors: validated.errors, config: DEFAULT_CONFIG };
}
