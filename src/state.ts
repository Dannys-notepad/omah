// src/state.ts
// Run-scoped mutable state. Written from multiple places in the loop,
// read by the usage summary and the review gate. Values that get
// reassigned are exposed through setters, because ES module imports
// cannot be reassigned from outside their declaring module.

import type { State } from "./keystate.js";
import type { KeyStat, StepUsage } from "./types.js";

export const usageLog: StepUsage[] = [];
export const keyStats: Map<number, KeyStat> = new Map();

export let persistedState: State = {
  keys: { version: 1, updated_at: new Date().toISOString(), keys: {} },
  repos: { version: 1, updated_at: new Date().toISOString(), repos: [] },
};

export function setPersistedState(next: State): void {
  persistedState = next;
}

export let metaToken = "";

export function setMetaToken(next: string): void {
  metaToken = next;
}

export let stateLoadOk = false;

export function setStateLoadOk(next: boolean): void {
  stateLoadOk = next;
}

export let stateSaved = false;

export function setStateSaved(next: boolean): void {
  stateSaved = next;
}

export let lastUsedProvider: string | null = null;

export function setLastUsedProvider(next: string | null): void {
  lastUsedProvider = next;
}

export function recordKeyCall(keyIndex: number): void {
  const s = keyStats.get(keyIndex) ?? { calls: 0, rate429: 0, errors: 0 };
  s.calls += 1;
  keyStats.set(keyIndex, s);
}

export function recordKeyRateLimit(keyIndex: number, message: string): void {
  const s = keyStats.get(keyIndex) ?? { calls: 0, rate429: 0, errors: 0 };
  s.rate429 += 1;
  s.lastError = message.slice(0, 300);
  keyStats.set(keyIndex, s);
}

export function recordKeyError(keyIndex: number, message: string): void {
  const s = keyStats.get(keyIndex) ?? { calls: 0, rate429: 0, errors: 0 };
  s.errors += 1;
  s.lastError = message.slice(0, 300);
  keyStats.set(keyIndex, s);
}