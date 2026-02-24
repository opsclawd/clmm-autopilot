export function unixDaysFromUnixTs(unixTsSeconds: number): number {
  if (!Number.isFinite(unixTsSeconds)) throw new Error('unixTsSeconds must be finite');
  if (!Number.isInteger(unixTsSeconds)) throw new Error('unixTsSeconds must be an integer');
  return Math.floor(unixTsSeconds / 86400);
}

export function unixDaysFromUnixMs(unixMs: number): number {
  if (!Number.isFinite(unixMs)) throw new Error('unixMs must be finite');
  return Math.floor(unixMs / 86_400_000);
}
