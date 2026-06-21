import { describe, expect, it } from 'bun:test';
import {
  type Deps,
  type Env,
  type ExchangeResult,
  escapeRegExp,
  handleRequest,
  isAllowedDomain,
  outputHTML,
} from './handler';

const FIXED_TOKEN = '0123456789abcdef0123456789abcdef';

/** Build a dependency set with a stub token exchange and deterministic CSRF token. */
const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  generateCsrfToken: () => FIXED_TOKEN,
  exchangeToken: async () => ({ status: 'ok', token: 'gho_test_token' }) as ExchangeResult,
  ...overrides,
});

const baseEnv: Env = {
  GITHUB_CLIENT_ID: 'gh_client_id',
  GITHUB_CLIENT_SECRET: 'gh_client_secret',
  GITLAB_CLIENT_ID: 'gl_client_id',
  GITLAB_CLIENT_SECRET: 'gl_client_secret',
};

const get = (url: string, init: RequestInit = {}) => new Request(url, { method: 'GET', ...init });

describe('isAllowedDomain — ALLOWED_DOMAINS wildcard matching', () => {
  it('allows everything when the list is unset or empty', () => {
    expect(isAllowedDomain('anything.com', undefined)).toBe(true);
    expect(isAllowedDomain('anything.com', '')).toBe(true);
  });

  it('matches an exact domain', () => {
    expect(isAllowedDomain('example.com', 'example.com')).toBe(true);
    expect(isAllowedDomain('evil.com', 'example.com')).toBe(false);
  });

  it('*.example.com matches a subdomain but not the apex', () => {
    expect(isAllowedDomain('a.example.com', '*.example.com')).toBe(true);
    expect(isAllowedDomain('deep.nested.example.com', '*.example.com')).toBe(true);
    expect(isAllowedDomain('example.com', '*.example.com')).toBe(false);
  });

  it('does not let the wildcard leak past the dot boundary', () => {
    // `.` is escaped, so `*.example.com` must not match `aexample.com`.
    expect(isAllowedDomain('aexample.com', '*.example.com')).toBe(false);
    // Anchored on both ends — no trailing-suffix bypass.
    expect(isAllowedDomain('a.example.com.evil.com', '*.example.com')).toBe(false);
  });

  it('honours a comma-separated list with trimming', () => {
    const list = 'example.com, *.example.org ,localhost';
    expect(isAllowedDomain('example.com', list)).toBe(true);
    expect(isAllowedDomain('sub.example.org', list)).toBe(true);
    expect(isAllowedDomain('localhost', list)).toBe(true);
    expect(isAllowedDomain('example.net', list)).toBe(false);
  });

  it('escapes regex metacharacters in entries', () => {
    // The `.` must be literal, not "any char".
    expect(isAllowedDomain('exampleXcom', 'example.com')).toBe(false);
  });
});

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c+')).toBe('a\\.b\\*c\\+');
  });
});

describe('outputHTML — postMessage string formats', () => {
  it('emits the success handshake with provider and token', async () => {
    const html = await outputHTML({ provider: 'github', token: 'gho_abc' }).text();
    // Step 1: popup announces itself to the opener with target origin `*`.
    expect(html).toContain("window.opener?.postMessage('authorizing:github', '*')");
    // Step 3: on the opener's reply, popup posts the success payload to the message origin.
    expect(html).toContain("if (data === 'authorizing:github')");
    expect(html).toContain(
      `'authorization:github:success:${JSON.stringify({ provider: 'github', token: 'gho_abc' })}'`,
    );
  });

  it('emits the error handshake with provider, error, and errorCode', async () => {
    const html = await outputHTML({
      provider: 'github',
      error: 'boom',
      errorCode: 'SOME_CODE',
    }).text();
    expect(html).toContain(
      `'authorization:github:error:${JSON.stringify({ provider: 'github', error: 'boom', errorCode: 'SOME_CODE' })}'`,
    );
  });

  it('deletes the CSRF cookie', () => {
    const res = outputHTML({ provider: 'github', token: 't' });
    expect(res.headers.get('Set-Cookie')).toContain('csrf-token=deleted');
    expect(res.headers.get('Content-Type')).toBe('text/html;charset=UTF-8');
  });
});

describe('handleRequest — GET /auth', () => {
  it('redirects to GitHub authorize with the CSRF cookie and state, no redirect_uri', async () => {
    const res = await handleRequest(
      get('https://broker.example/auth?provider=github&site_id=example.com'),
      { ...baseEnv, ALLOWED_DOMAINS: 'example.com' },
      makeDeps(),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const authURL = new URL(location);
    expect(authURL.origin + authURL.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authURL.searchParams.get('client_id')).toBe('gh_client_id');
    expect(authURL.searchParams.get('scope')).toBe('repo,user');
    expect(authURL.searchParams.get('state')).toBe(FIXED_TOKEN);
    // Upstream GitHub authorize does NOT include redirect_uri.
    expect(authURL.searchParams.has('redirect_uri')).toBe(false);

    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toContain(`csrf-token=github_${FIXED_TOKEN};`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('redirects to GitLab authorize with redirect_uri, response_type, and api scope', async () => {
    const res = await handleRequest(
      get('https://broker.example/oauth/authorize?provider=gitlab&site_id=example.com'),
      baseEnv,
      makeDeps(),
    );
    expect(res.status).toBe(302);
    const authURL = new URL(res.headers.get('Location')!);
    expect(authURL.origin + authURL.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(authURL.searchParams.get('scope')).toBe('api');
    expect(authURL.searchParams.get('response_type')).toBe('code');
    expect(authURL.searchParams.get('redirect_uri')).toBe('https://broker.example/callback');
  });

  it('rejects a disallowed domain before redirecting', async () => {
    const res = await handleRequest(
      get('https://broker.example/auth?provider=github&site_id=evil.com'),
      { ...baseEnv, ALLOWED_DOMAINS: 'example.com' },
      makeDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UNSUPPORTED_DOMAIN');
  });

  it('rejects an unsupported provider', async () => {
    const res = await handleRequest(
      get('https://broker.example/auth?provider=bitbucket&site_id=example.com'),
      baseEnv,
      makeDeps(),
    );
    expect(await res.text()).toContain('UNSUPPORTED_BACKEND');
  });

  it('reports a misconfigured client when secrets are missing', async () => {
    const res = await handleRequest(
      get('https://broker.example/auth?provider=github&site_id=example.com'),
      {},
      makeDeps(),
    );
    expect(await res.text()).toContain('MISCONFIGURED_CLIENT');
  });
});

describe('handleRequest — GET /callback (CSRF state validation)', () => {
  const cookie = `csrf-token=github_${FIXED_TOKEN}`;

  it('exchanges the code and returns the success handshake on a valid state', async () => {
    let exchanged = false;
    const res = await handleRequest(
      get(`https://broker.example/callback?code=abc&state=${FIXED_TOKEN}`, {
        headers: { Cookie: cookie },
      }),
      baseEnv,
      makeDeps({
        exchangeToken: async () => {
          exchanged = true;
          return { status: 'ok', token: 'gho_real' };
        },
      }),
    );
    expect(exchanged).toBe(true);
    const html = await res.text();
    expect(html).toContain('authorization:github:success:');
    expect(html).toContain('gho_real');
  });

  it('aborts with CSRF_DETECTED when state does not match the cookie', async () => {
    let exchanged = false;
    const res = await handleRequest(
      get('https://broker.example/callback?code=abc&state=deadbeefdeadbeefdeadbeefdeadbeef', {
        headers: { Cookie: cookie },
      }),
      baseEnv,
      makeDeps({
        exchangeToken: async () => {
          exchanged = true;
          return { status: 'ok' };
        },
      }),
    );
    expect(exchanged).toBe(false);
    expect(await res.text()).toContain('CSRF_DETECTED');
  });

  it('reports AUTH_CODE_REQUEST_FAILED when code or state is missing', async () => {
    const res = await handleRequest(
      get(`https://broker.example/callback?state=${FIXED_TOKEN}`, { headers: { Cookie: cookie } }),
      baseEnv,
      makeDeps(),
    );
    expect(await res.text()).toContain('AUTH_CODE_REQUEST_FAILED');
  });

  it('reports UNSUPPORTED_BACKEND when the cookie is missing/unparseable', async () => {
    const res = await handleRequest(
      get(`https://broker.example/callback?code=abc&state=${FIXED_TOKEN}`),
      baseEnv,
      makeDeps(),
    );
    expect(await res.text()).toContain('UNSUPPORTED_BACKEND');
  });

  it('maps network failures to TOKEN_REQUEST_FAILED', async () => {
    const res = await handleRequest(
      get(`https://broker.example/callback?code=abc&state=${FIXED_TOKEN}`, {
        headers: { Cookie: cookie },
      }),
      baseEnv,
      makeDeps({ exchangeToken: async () => ({ status: 'network_error' }) }),
    );
    expect(await res.text()).toContain('TOKEN_REQUEST_FAILED');
  });

  it('maps malformed payloads to MALFORMED_RESPONSE', async () => {
    const res = await handleRequest(
      get(`https://broker.example/callback?code=abc&state=${FIXED_TOKEN}`, {
        headers: { Cookie: cookie },
      }),
      baseEnv,
      makeDeps({ exchangeToken: async () => ({ status: 'malformed' }) }),
    );
    expect(await res.text()).toContain('MALFORMED_RESPONSE');
  });

  it('passes the provider error through to the handshake', async () => {
    const res = await handleRequest(
      get(`https://broker.example/callback?code=abc&state=${FIXED_TOKEN}`, {
        headers: { Cookie: cookie },
      }),
      baseEnv,
      makeDeps({ exchangeToken: async () => ({ status: 'ok', error: 'bad_verification_code' }) }),
    );
    expect(await res.text()).toContain('authorization:github:error:');
  });
});

describe('handleRequest — routing', () => {
  it('GET / redirects to CMS_ADMIN_URL when set', async () => {
    const res = await handleRequest(
      get('https://broker.example/'),
      {
        CMS_ADMIN_URL: 'https://cms.example/admin/',
      },
      makeDeps(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://cms.example/admin/');
  });

  it('GET / returns a 200 health body when CMS_ADMIN_URL is unset', async () => {
    const res = await handleRequest(get('https://broker.example/'), {}, makeDeps());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('sveltia-cms-auth OK');
  });

  it('the /oauth/redirect alias routes to the callback handler', async () => {
    const res = await handleRequest(
      get(`https://broker.example/oauth/redirect?code=abc&state=${FIXED_TOKEN}`, {
        headers: { Cookie: `csrf-token=github_${FIXED_TOKEN}` },
      }),
      baseEnv,
      makeDeps(),
    );
    expect(await res.text()).toContain('authorization:github:success:');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await handleRequest(get('https://broker.example/nope'), {}, makeDeps());
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-GET methods', async () => {
    const res = await handleRequest(
      new Request('https://broker.example/auth?provider=github', { method: 'POST' }),
      baseEnv,
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });
});
