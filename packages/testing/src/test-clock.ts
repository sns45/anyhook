/** @fileoverview Controllable Clock + seeded Rng for deterministic tests. @module @anyhook/testing */
import type { Clock, Rng } from '@anyhook/core';

/** A Clock whose time only advances when the test tells it to. */
export class TestClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  /** Advance by `ms` and return the new time. */
  tick(ms: number): number {
    this.t += ms;
    return this.t;
  }
  /** Jump to an absolute time (never moves backwards). */
  set(ms: number): number {
    if (ms > this.t) this.t = ms;
    return this.t;
  }
}

/** Deterministic LCG Rng in [0, 1). */
export function seededRng(seed = 1): Rng {
  let s = seed >>> 0 || 1;
  return {
    next(): number {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    },
  };
}
