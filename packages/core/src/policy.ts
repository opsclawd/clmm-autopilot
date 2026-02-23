export type Sample = {
  slot: number;
  unixTs: number;
  currentTickIndex: number;
};

export type Bounds = {
  lowerTickIndex: number;
  upperTickIndex: number;
};

export type Config = {
  requiredConsecutive: number;
  cadenceMs: number;
  cooldownMs: number;
  lastTriggerUnixTs?: number;
  lastEvaluatedSample?: Sample;
};

export type ReasonCode =
  | 'DATA_UNAVAILABLE'
  | 'IN_RANGE'
  | 'DEBOUNCE_NOT_MET'
  | 'COOLDOWN_ACTIVE'
  | 'DUPLICATE_EVALUATION'
  | 'NON_MONOTONIC_SAMPLE'
  | 'TRIGGER_DOWN_CONSECUTIVE'
  | 'TRIGGER_UP_CONSECUTIVE';

export type Decision = {
  action: 'HOLD' | 'TRIGGER_DOWN' | 'TRIGGER_UP';
  reasonCode: ReasonCode;
  debug: {
    samplesUsed: number;
    threshold: number;
    cooldownRemainingMs: number;
  };
  nextState: {
    lastTriggerUnixTs?: number;
    lastEvaluatedSample?: Sample;
  };
};

type Side = 'DOWN' | 'UP' | 'IN_RANGE';

function isValidSample(v: Sample): boolean {
  return (
    Number.isFinite(v.slot) &&
    Number.isFinite(v.unixTs) &&
    Number.isFinite(v.currentTickIndex) &&
    Number.isInteger(v.slot) &&
    Number.isInteger(v.unixTs) &&
    Number.isInteger(v.currentTickIndex)
  );
}

function canonicalize(samples: readonly Sample[]): Sample[] {
  const sorted = samples
    .filter(isValidSample)
    .slice()
    .sort(
      (a, b) =>
        a.slot - b.slot || a.unixTs - b.unixTs || a.currentTickIndex - b.currentTickIndex,
    );

  const deduped: Sample[] = [];
  for (const s of sorted) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.slot === s.slot &&
      prev.unixTs === s.unixTs &&
      prev.currentTickIndex === s.currentTickIndex
    ) {
      continue;
    }
    deduped.push(s);
  }
  return deduped;
}

function classify(sample: Sample, bounds: Bounds): Side {
  if (sample.currentTickIndex < bounds.lowerTickIndex) return 'DOWN';
  if (sample.currentTickIndex > bounds.upperTickIndex) return 'UP';
  return 'IN_RANGE';
}

function trailingConsecutiveWithinCadence(
  samples: readonly Sample[],
  classified: readonly Side[],
  side: Exclude<Side, 'IN_RANGE'>,
  cadenceMs: number,
): number {
  let streak = 0;
  for (let i = classified.length - 1; i >= 0; i -= 1) {
    if (classified[i] !== side) break;

    if (i < classified.length - 1) {
      const newer = samples[i + 1];
      const older = samples[i];
      const gapMs = (newer.unixTs - older.unixTs) * 1000;
      if (gapMs > cadenceMs) break;
    }

    streak += 1;
  }
  return streak;
}

function cooldownRemainingMs(lastTriggerUnixTs: number | undefined, latestUnixTs: number, cooldownMs: number): number {
  if (lastTriggerUnixTs == null) return 0;
  const elapsedMs = (latestUnixTs - lastTriggerUnixTs) * 1000;
  return Math.max(0, cooldownMs - elapsedMs);
}

function sameSample(a?: Sample, b?: Sample): boolean {
  if (!a || !b) return false;
  return a.slot === b.slot && a.unixTs === b.unixTs && a.currentTickIndex === b.currentTickIndex;
}

export function evaluateRangeBreak(
  samples: readonly Sample[],
  bounds: Bounds,
  config: Config,
): Decision {
  const canonical = canonicalize(samples);
  const threshold = config.requiredConsecutive * config.cadenceMs;

  if (canonical.length === 0) {
    return {
      action: 'HOLD',
      reasonCode: 'DATA_UNAVAILABLE',
      debug: { samplesUsed: 0, threshold, cooldownRemainingMs: 0 },
      nextState: {
        lastTriggerUnixTs: config.lastTriggerUnixTs,
        lastEvaluatedSample: config.lastEvaluatedSample,
      },
    };
  }

  const latest = canonical[canonical.length - 1];
  const cooldown = cooldownRemainingMs(config.lastTriggerUnixTs, latest.unixTs, config.cooldownMs);

  if (sameSample(latest, config.lastEvaluatedSample)) {
    return {
      action: 'HOLD',
      reasonCode: 'DUPLICATE_EVALUATION',
      debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: cooldown },
      nextState: {
        lastTriggerUnixTs: config.lastTriggerUnixTs,
        lastEvaluatedSample: config.lastEvaluatedSample,
      },
    };
  }

  if (
    config.lastEvaluatedSample &&
    (latest.slot < config.lastEvaluatedSample.slot ||
      (latest.slot === config.lastEvaluatedSample.slot &&
        latest.unixTs < config.lastEvaluatedSample.unixTs))
  ) {
    return {
      action: 'HOLD',
      reasonCode: 'NON_MONOTONIC_SAMPLE',
      debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: cooldown },
      nextState: {
        lastTriggerUnixTs: config.lastTriggerUnixTs,
        lastEvaluatedSample: config.lastEvaluatedSample,
      },
    };
  }

  const classified = canonical.map((s) => classify(s, bounds));
  const latestClass = classified[classified.length - 1];

  const baseState = {
    lastTriggerUnixTs: config.lastTriggerUnixTs,
    lastEvaluatedSample: latest,
  };

  if (latestClass === 'IN_RANGE') {
    return {
      action: 'HOLD',
      reasonCode: 'IN_RANGE',
      debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: cooldown },
      nextState: baseState,
    };
  }

  const streak = trailingConsecutiveWithinCadence(canonical, classified, latestClass, config.cadenceMs);
  if (streak < config.requiredConsecutive) {
    return {
      action: 'HOLD',
      reasonCode: 'DEBOUNCE_NOT_MET',
      debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: cooldown },
      nextState: baseState,
    };
  }

  if (cooldown > 0) {
    return {
      action: 'HOLD',
      reasonCode: 'COOLDOWN_ACTIVE',
      debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: cooldown },
      nextState: baseState,
    };
  }

  if (latestClass === 'DOWN') {
    return {
      action: 'TRIGGER_DOWN',
      reasonCode: 'TRIGGER_DOWN_CONSECUTIVE',
      debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: 0 },
      nextState: {
        lastTriggerUnixTs: latest.unixTs,
        lastEvaluatedSample: latest,
      },
    };
  }

  return {
    action: 'TRIGGER_UP',
    reasonCode: 'TRIGGER_UP_CONSECUTIVE',
    debug: { samplesUsed: canonical.length, threshold, cooldownRemainingMs: 0 },
    nextState: {
      lastTriggerUnixTs: latest.unixTs,
      lastEvaluatedSample: latest,
    },
  };
}
