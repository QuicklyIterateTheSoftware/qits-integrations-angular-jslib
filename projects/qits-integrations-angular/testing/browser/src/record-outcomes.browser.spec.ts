import { TestBed } from '@angular/core/testing';
import { outcomes, stay } from '@qits/angular';
import { outcomeRecords, recordOutcomes, takeOutcomeRecords } from './record-outcomes';

/**
 * In a real browser run, as an app's setup file uses it: the main entry's recorder is reached
 * through the package name, and Vitest names the spec and the test.
 */
recordOutcomes();

const SPEC = expect.stringMatching(/testing\/browser\/src\/record-outcomes\.browser\.spec\.ts$/);

function reachRefused(): void {
  TestBed.runInInjectionContext(() =>
    outcomes('create-work-item', { refused: stay() }),
  ).refused.reach();
}

describe('recordOutcomes', () => {
  it('records what a test reaches, with its spec and its test', () => {
    reachRefused();
    expect(outcomeRecords()).toEqual([
      {
        interaction: 'create-work-item',
        outcome: 'refused',
        kind: 'stay',
        to: null,
        spec: SPEC,
        test: 'recordOutcomes > records what a test reaches, with its spec and its test',
      },
    ]);
  });

  it('starts every test with no records', () => {
    expect(outcomeRecords()).toEqual([]);
    reachRefused();
    reachRefused();
    expect(outcomeRecords()).toHaveLength(2);
  });

  it('hands over the file’s records once', () => {
    expect(takeOutcomeRecords().map((record) => record.test)).toEqual([
      'recordOutcomes > records what a test reaches, with its spec and its test',
      'recordOutcomes > starts every test with no records',
      'recordOutcomes > starts every test with no records',
    ]);
    expect(takeOutcomeRecords()).toEqual([]);
    // The current test's own records are not drained with the file's.
    reachRefused();
    expect(outcomeRecords()).toHaveLength(1);
  });
});
