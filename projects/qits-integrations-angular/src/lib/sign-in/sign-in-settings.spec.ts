import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route } from '@angular/router';
import { QitsAuthCallbackPage } from './auth-callback.page';
import { provideQitsBearerSignIn } from './provide-qits-bearer-sign-in';
import { isPlatformUrl, platformDomainOf, QITS_SIGN_IN } from './sign-in-settings';
import type { QitsBearerSignInOptions } from './sign-in-settings';

describe('platformDomainOf', () => {
  it('answers the apex itself, and drops the label of an application host', () => {
    expect(platformDomainOf('qits.example.com')).toBe('qits.example.com');
    expect(platformDomainOf('ci.qits.example.com')).toBe('qits.example.com');
    expect(platformDomainOf('registry.qits.qits.dev')).toBe('qits.qits.dev');
    expect(platformDomainOf('qits.qits.dev')).toBe('qits.qits.dev');
  });
});

describe('isPlatformUrl', () => {
  const page = 'https://ci.qits.example/runs';

  it('takes this origin, the apex and every https name under it', () => {
    expect(isPlatformUrl('/ci/api/runs', page, 'qits.example')).toBe(true);
    expect(isPlatformUrl('https://qits.example/x', page, 'qits.example')).toBe(true);
    expect(isPlatformUrl('https://projects.qits.example/x', page, 'qits.example')).toBe(true);
  });

  it('refuses plain http, look-alikes and other hosts', () => {
    expect(isPlatformUrl('http://projects.qits.example/x', page, 'qits.example')).toBe(false);
    expect(isPlatformUrl('https://evilqits.example/x', page, 'qits.example')).toBe(false);
    expect(isPlatformUrl('https://qits.example.evil/x', page, 'qits.example')).toBe(false);
    expect(isPlatformUrl('https://other.example/x', page, '')).toBe(false);
  });

  it('takes the loopback page’s own calls under ng serve', () => {
    expect(isPlatformUrl('/projects/api', 'http://localhost:4200/', 'qits.example')).toBe(true);
  });
});

describe('provideQitsBearerSignIn', () => {
  function settings(options: QitsBearerSignInOptions, hostname = 'ci.qits.example') {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: DOCUMENT, useValue: { location: { hostname } } },
        provideQitsBearerSignIn({ ...options, callbackRoute: false }),
      ],
    });
    return TestBed.inject(QITS_SIGN_IN);
  }

  it("reads the platform domain from the page's host, and the idp under it", () => {
    expect(settings({ clientId: 'qits-spa' })).toEqual({
      clientId: 'qits-spa',
      platformDomain: 'qits.example',
      idpOrigin: 'https://idp.qits.example',
    });
  });

  it('takes a stated domain and idp (ng serve)', () => {
    expect(
      settings({ clientId: 'qits-landing-dev', platformDomain: 'qits.wohlben.eu' }, 'localhost'),
    ).toEqual({
      clientId: 'qits-landing-dev',
      platformDomain: 'qits.wohlben.eu',
      idpOrigin: 'https://idp.qits.wohlben.eu',
    });
    TestBed.resetTestingModule();
    expect(settings({ clientId: 'qits-spa', idpOrigin: 'https://login.example/' }).idpOrigin).toBe(
      'https://login.example',
    );
  });

  it('refuses a missing client id', () => {
    expect(() => settings({ clientId: '' })).toThrow(/clientId/);
  });

  function routes(appRoutes: Route[], callbackRoute?: boolean): Route[] {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(appRoutes),
        provideQitsBearerSignIn({ clientId: 'qits-spa', callbackRoute }),
      ],
    });
    return TestBed.inject(Router).config;
  }

  it("puts auth/callback in front of the app's routes, before a wildcard", () => {
    const config = routes([{ path: '**', redirectTo: '' }]);
    expect(config.map((route) => route.path)).toEqual(['auth/callback', '**']);
    expect(config[0].component).toBe(QitsAuthCallbackPage);
  });

  it('leaves an app that placed the route itself, or opted out, alone', () => {
    expect(routes([{ path: 'auth/callback', redirectTo: '' }]).length).toBe(1);
    TestBed.resetTestingModule();
    expect(routes([{ path: '**', redirectTo: '' }], false).map((r) => r.path)).toEqual(['**']);
  });
});
