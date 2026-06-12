/**
 * clock.ts — Clock interface for the billing package.
 *
 * Local re-export so the billing package does not cross the rootDir boundary
 * to import from backend/src/clock.ts. The interface is structurally identical
 * so any backend Clock implementation satisfies it at the call site.
 *
 * See also: backend/src/clock.ts (source of truth).
 */

/** Clock interface — everything time-dependent injects this. */
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
 * Manual clock for tests — advances only when advance() is called.
 * Useful for billing tests that need deterministic time progression.
 */
export class ManualClock implements Clock {
  private current: Date;

  constructor(startAt?: Date) {
    this.current = startAt ? new Date(startAt) : new Date();
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Set the clock to an absolute time. */
  setNow(d: Date): void {
    this.current = new Date(d);
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
