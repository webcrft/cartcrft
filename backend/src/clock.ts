/**
 * Clock interface — everything time-dependent injects this so billingsim can
 * compress a "day" to N seconds in dev/test without touching real time calls.
 */
export interface Clock {
  now(): Date;
}

/** Production clock: delegates to Date.now(). */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Simulated clock for billingsim / tests.
 *
 * SimClock starts at `epoch` (default: now at construction time) and advances
 * wall-clock time scaled by `scale`.  When `scale = 1` it behaves like
 * SystemClock.  When `scale = 86400` a real second equals a simulated day.
 *
 * Usage:
 *   const clock = new SimClock(new Date('2026-01-01'), 86400);
 *   clock.now(); // returns simulated time
 */
export class SimClock implements Clock {
  private readonly epoch: number;
  private readonly wallEpoch: number;
  private readonly scale: number;

  constructor(startAt?: Date, scale = 1) {
    this.epoch = (startAt ?? new Date()).getTime();
    this.wallEpoch = Date.now();
    this.scale = scale;
  }

  now(): Date {
    const wallElapsedMs = Date.now() - this.wallEpoch;
    return new Date(this.epoch + wallElapsedMs * this.scale);
  }

  /** Advance the simulated epoch by `ms` milliseconds (useful in tests). */
  advance(ms: number): void {
    // Cast away readonly for internal mutation — intentional.
    (this as unknown as { epoch: number }).epoch += ms;
  }
}
