/**
 * Records where each test's interactions led (ticket qits-2001). Call {@link recordOutcomes} once in
 * the browser specs' setup file, beside `guardGoldenMasters()` and `freezeScreenshots()`: every
 * `go()`, `reach()` and handled `QitsExit` click of the main entry's `outcomes()` is then noted,
 * with the spec file and the test that reached it.
 *
 * The main entry records through its `ɵsetOutcomeRecorder` seam, which this entry reaches because it
 * imports `@qits/angular` by package name: one module instance, one recorder.
 */
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '@qits/angular';
import { afterEach, beforeEach, expect } from 'vitest';

/** One outcome a test reached: the main entry's record, plus where it was reached. */
export interface TestOutcomeRecord extends OutcomeRecord {
  /** The spec file (Vitest's `expect.getState().testPath`). */
  readonly spec: string;
  /** The test's full name (`describe > it`, Vitest's `currentTestName`). */
  readonly test: string;
}

/** The current test's records, in the order they were reached. */
const testOutcomes: TestOutcomeRecord[] = [];

/** The spec file's records since the last {@link takeOutcomeRecords}, in the order they were reached. */
const fileOutcomes: TestOutcomeRecord[] = [];

const record = (outcome: OutcomeRecord): void => {
  const state = expect.getState();
  const recorded: TestOutcomeRecord = Object.freeze({
    ...outcome,
    spec: state.testPath ?? '',
    test: state.currentTestName ?? '',
  });
  testOutcomes.push(recorded);
  fileOutcomes.push(recorded);
};

/**
 * Installs the outcome recorder for each test: before every test it forgets the last test's
 * records and installs the recorder, and after it removes the recorder again, so an outcome
 * reached outside a test (in `beforeAll`, or by a navigation that settles later) is not pinned on
 * the wrong one. Call it once, in the setup file.
 */
export function recordOutcomes(): void {
  beforeEach(() => {
    testOutcomes.length = 0;
    ɵsetOutcomeRecorder(record);
  });
  afterEach(() => {
    ɵsetOutcomeRecorder(null);
  });
}

/** The outcomes the current test has reached so far, in order: for assertions. */
export function outcomeRecords(): TestOutcomeRecord[] {
  return [...testOutcomes];
}

/**
 * The spec file's outcomes since the last call, in the order they were reached, and forgets them,
 * as `takeRouteRecords()` does for routes: `afterAll(() => send(takeOutcomeRecords()))`.
 */
export function takeOutcomeRecords(): TestOutcomeRecord[] {
  return fileOutcomes.splice(0);
}
