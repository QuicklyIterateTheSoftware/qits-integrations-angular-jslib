import { buildCapturePayload } from './capture-payload';
import { registerCaptureState, resetCaptureStateForTesting } from './capture-state';
import { resetRouteContextForTesting, setCurrentRoute } from './route-context';

const RELAY = {
  ingestUrl: 'http://qits:8080/api/capture',
  resourceAttributes: { 'qits.repository.id': 'repo-1', 'qits.workspace.id': 'work-1' },
};

const DOM = { html: '<html></html>', truncated: false, bytes: 13 };

describe('buildCapturePayload', () => {
  const originalPath = location.pathname;
  let baseTag: HTMLBaseElement | undefined;

  beforeEach(() => {
    // jsdom has no matchMedia; the builder only reads .matches.
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    baseTag?.remove();
    baseTag = undefined;
    history.replaceState(null, '', originalPath);
    resetRouteContextForTesting();
    resetCaptureStateForTesting();
  });

  function setBase(href: string): void {
    baseTag = document.createElement('base');
    baseTag.setAttribute('href', href);
    document.head.appendChild(baseTag);
  }

  it('self-stamps the relayed identity', () => {
    const payload = buildCapturePayload(DOM, RELAY);
    expect(payload.identity).toEqual({
      'qits.repository.id': 'repo-1',
      'qits.workspace.id': 'work-1',
    });
  });

  it('identity fields are null when the relay carries no attributes', () => {
    const payload = buildCapturePayload(DOM, { ingestUrl: 'http://x', resourceAttributes: {} });
    expect(payload.identity).toEqual({
      'qits.repository.id': null,
      'qits.workspace.id': null,
    });
  });

  it('appPath strips the <base> prefix — rebased deploys report the app-side path', () => {
    setBase('/my-app/');
    history.replaceState(null, '', '/my-app/greeting/anna');
    expect(buildCapturePayload(DOM, RELAY).page.appPath).toBe('greeting/anna');
  });

  it('appPath is the bare path at a root deploy (<base href="/">)', () => {
    setBase('/');
    history.replaceState(null, '', '/greeting/anna');
    expect(buildCapturePayload(DOM, RELAY).page.appPath).toBe('greeting/anna');
  });

  it('routePattern comes from the tracked route, null before the first navigation', () => {
    expect(buildCapturePayload(DOM, RELAY).page.routePattern).toBeNull();
    setCurrentRoute({ path: 'greeting/:name', url: '/greeting/anna' });
    expect(buildCapturePayload(DOM, RELAY).page.routePattern).toBe('greeting/:name');
  });

  it('captures page and environment metadata', () => {
    const payload = buildCapturePayload(DOM, RELAY);
    expect(payload.page.url).toBe(location.href);
    expect(payload.page.title).toBe(document.title);
    expect(payload.environment.viewport).toEqual({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    });
    expect(payload.environment.userAgent).toBe(navigator.userAgent);
    expect(payload.environment.prefersColorScheme).toBe('dark');
    expect(payload.dom).toBe(DOM);
    expect(new Date(payload.capturedAt).getTime()).not.toBeNaN();
  });

  it('omits state entirely when nothing is registered', () => {
    expect('state' in buildCapturePayload(DOM, RELAY)).toBe(false);
  });

  it('omits selection when no pick is supplied', () => {
    expect('selection' in buildCapturePayload(DOM, RELAY)).toBe(false);
  });

  it('carries the supplied selection verbatim', () => {
    const selection = {
      html: '<app-card>frozen</app-card>',
      truncated: false,
      bytes: 27,
      selector: '#go',
      tag: 'button',
      component: 'app-card',
    };
    expect(buildCapturePayload(DOM, RELAY, selection).selection).toBe(selection);
  });

  it('carries registered state, sanitized, under its registration name', () => {
    registerCaptureState('greetingHistory', () => ({ greetings: ['anna'], when: new Map() }));
    expect(buildCapturePayload(DOM, RELAY).state).toEqual({
      greetingHistory: { greetings: ['anna'], when: {} },
    });
  });
});
