/**
 * qits-2167 verify probe: a browser spec that must fail, to prove the npm-library gate runs
 * `test:browser` and goes red on it. Removed by the next commit.
 */
describe('qits-2167 gate probe', () => {
  it('fails in the browser so the gate must reject this fold', () => {
    expect(document.defaultView?.navigator.userAgent).toContain('qits-2167-never-matches');
  });
});
