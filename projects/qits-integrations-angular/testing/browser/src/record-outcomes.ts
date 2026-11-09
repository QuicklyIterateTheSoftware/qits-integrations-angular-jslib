/**
 * Records where each test's interactions led (ticket qits-2001). Call {@link recordOutcomes} once in
 * the browser specs' setup file, beside `guardGoldenMasters()` and `freezeScreenshots()`: every
 * `go()`, `reach()` and handled `QitsExit` click of the main entry's `outcomes()` is then noted,
 * with the spec file and the test that reached it.
 *
 * The main entry records through its `ɵsetOutcomeRecorder` seam, which this entry reaches because it
 * imports `@qits/angular` by package name: one module instance, one recorder.
 *
 * After each test its records go to the Node side through the `qitsOutcomes` browser command
 * (ticket qits-2003), which `screenshotReferences({ freezes })` registers: they land in the freeze
 * manifest, where `qits-angular screenshots --check` holds them against the declared outcomes.
 * Without that command registered, nothing is sent.
 */
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '@qits/angular';
import { afterEach, beforeEach, expect } from 'vitest';
import { currentRoutePattern } from './golden-master-guard';

/** The browser command each test's records are sent to; `screenshotReferences({ freezes })` registers it. */
export const OUTCOMES_COMMAND = 'qitsOutcomes';

/** One outcome a test reached: the main entry's record, plus where it was reached. */
export interface TestOutcomeRecord extends OutcomeRecord {
  /** The spec file (Vitest's `expect.getState().testPath`). */
  readonly spec: string;
  /** The test's full name (`describe > it`, Vitest's `currentTestName`). */
  readonly test: string;
  /** The route pattern the TestBed's router had matched when it was reached, or `null`. */
  readonly route: string | null;
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
    route: currentRoutePattern(),
  });
  testOutcomes.push(recorded);
  fileOutcomes.push(recorded);
};

/**
 * Installs the outcome recorder for each test: before every test it forgets the last test's
 * records and installs the recorder, and after it sends the test's records through
 * {@link OUTCOMES_COMMAND} (when registered) and removes the recorder again, so an outcome reached
 * outside a test (in `beforeAll`, or by a navigation that settles later) is not pinned on the
 * wrong one. Call it once, in the setup file.
 */
export function recordOutcomes(): void {
  beforeEach(() => {
    testOutcomes.length = 0;
    ɵsetOutcomeRecorder(record);
  });
  afterEach(async () => {
    try {
      if (testOutcomes.length > 0) await send([...testOutcomes]);
    } finally {
      ɵsetOutcomeRecorder(null);
    }
  });
}

type Command = (...args: unknown[]) => Promise<unknown>;

/**
 * Sends a test's records to the Node side. `vitest/browser` is imported only here, as
 * `freezeScreenshots()` does: a static import would make every import of this entry need a
 * browser run.
 */
async function send(records: TestOutcomeRecord[]): Promise<void> {
  const { commands } = await import('vitest/browser');
  const command = (commands as unknown as Record<string, Command | undefined>)[OUTCOMES_COMMAND];
  if (command) await command(records);
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
