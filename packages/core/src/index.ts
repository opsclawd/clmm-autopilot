export type NonEmptyArray<T> = [T, ...T[]];

export * from './policy';
export * from './shellUx';

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new Error('min must be <= max');
  return Math.min(max, Math.max(min, value));
}

export function movingAverage(values: NonEmptyArray<number>): number {
  const total = values.reduce((acc, v) => acc + v, 0);
  return total / values.length;
}

export function hasConsecutive<T>(values: readonly T[], target: T, count: number): boolean {
  if (count <= 0) return true;
  let streak = 0;
  for (const value of values) {
    streak = value === target ? streak + 1 : 0;
    if (streak >= count) return true;
  }
  return false;
}
