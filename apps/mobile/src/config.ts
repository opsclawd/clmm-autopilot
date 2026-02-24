import { DEFAULT_CONFIG, validateConfig, type AutopilotConfig, type ConfigError } from '@clmm-autopilot/core';
import Constants from 'expo-constants';

export type LoadedAutopilotConfig =
  | { ok: true; config: AutopilotConfig }
  | { ok: false; errors: ConfigError[]; config: AutopilotConfig };

export function loadAutopilotConfig(): LoadedAutopilotConfig {
  const extra = (Constants.expoConfig as any)?.extra as Record<string, unknown> | undefined;
  const candidate = extra?.AUTOPILOT_CONFIG ?? extra?.autopilotConfig;
  const validated = validateConfig(candidate);
  if (validated.ok) return { ok: true, config: validated.value };
  return { ok: false, errors: validated.errors, config: DEFAULT_CONFIG };
}
