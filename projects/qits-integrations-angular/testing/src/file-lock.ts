/// <reference types="node" />
import { closeSync, openSync, rmSync } from 'node:fs';

/**
 * Runs `body` while holding the exclusive lock file `lock`; waits up to ten seconds for it. For a
 * read-modify-write of a committed file that several test processes may rewrite at once. Not part
 * of the public API.
 */
export function withLock<T>(lock: string, body: () => T): T {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`could not take ${lock}`);
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // busy-wait: the test runner gives no sync sleep
      }
    }
  }
  try {
    return body();
  } finally {
    rmSync(lock, { force: true });
  }
}
