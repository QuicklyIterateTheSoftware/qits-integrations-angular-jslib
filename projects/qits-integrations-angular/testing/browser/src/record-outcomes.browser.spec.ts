import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { outcomes, stay } from '@qits/angular';
import { commands } from 'vitest/browser';
import {
  OUTCOMES_COMMAND,
  outcomeRecords,
  recordOutcomes,
  takeOutcomeRecords,
  type TestOutcomeRecord,
} from './record-outcomes';

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

@Component({ template: '' })
class Blank {}

describe('recordOutcomes', () => {
  it('records what a test reaches, with its spec, its test and its route', () => {
    reachRefused();
    expect(outcomeRecords()).toEqual([
      {
        interaction: 'create-work-item',
        outcome: 'refused',
        kind: 'stay',
        to: null,
        spec: SPEC,
        test: 'recordOutcomes > records what a test reaches, with its spec, its test and its route',
        route: null,
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
      'recordOutcomes > records what a test reaches, with its spec, its test and its route',
      'recordOutcomes > starts every test with no records',
      'recordOutcomes > starts every test with no records',
    ]);
    expect(takeOutcomeRecords()).toEqual([]);
    // The current test's own records are not drained with the file's.
    reachRefused();
    expect(outcomeRecords()).toHaveLength(1);
  });

  it('notes the route the router had matched when the outcome was reached', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'projects/:slug/work/create', component: Blank }])],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/projects/demo/work/create');
    reachRefused();
    expect(outcomeRecords().map((record) => record.route)).toEqual(['projects/:slug/work/create']);
  });
});

describe('recordOutcomes sends each test’s records', () => {
  const sent: TestOutcomeRecord[][] = [];
  const registry = commands as unknown as Record<string, unknown>;

  // The command `screenshotReferences({ freezes })` registers in an app's run; this run has none.
  beforeAll(() => {
    registry[OUTCOMES_COMMAND] = async (records: TestOutcomeRecord[]) => {
      sent.push(records);
      return null;
    };
  });
  afterAll(() => {
    delete registry[OUTCOMES_COMMAND];
  });

  it('reaches two outcomes', () => {
    reachRefused();
    reachRefused();
  });

  it('reaches none', () => {
    expect(sent).toHaveLength(1);
  });

  it('sent them through qitsOutcomes after the test, and nothing for a test without any', () => {
    expect(OUTCOMES_COMMAND).toBe('qitsOutcomes');
    expect(sent).toHaveLength(1);
    expect(sent[0].map((record) => [record.test, record.outcome])).toEqual([
      ['recordOutcomes sends each test’s records > reaches two outcomes', 'refused'],
      ['recordOutcomes sends each test’s records > reaches two outcomes', 'refused'],
    ]);
  });
});
