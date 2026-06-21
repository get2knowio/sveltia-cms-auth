/**
 * Faithful port of the Cloudflare Worker `sveltia/sveltia-cms-auth` OAuth broker.
 *
 * The original lives at https://github.com/sveltia/sveltia-cms-auth/blob/main/src/index.js
 * and targets the Workers `fetch(request, env)` handler. This module keeps the exact protocol
 * (routes, CSRF cookie, postMessage handshake, error codes) but is framework-agnostic so it can
 * be served by `Bun.serve` and unit-tested without real network calls.
 */

/** List of supported OAuth providers. */
export const supportedProviders = ['github', 'gitlab'] as const;

export type Provider = (typeof supportedProviders)[number];

/** Environment variables consumed by the broker. */
export interface Env {
  ALLOWED_DOMAINS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_HOSTNAME?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  GITLAB_HOSTNAME?: string;
  /** Where `GET /` redirects (the CMS admin page). When unset, `GET /` returns a 200 health body. */
  CMS_ADMIN_URL?: string;
  PORT?: string;
  HOST?: string;
}

/** Outcome of a token exchange, abstracted so it can be mocked in tests. */
export type ExchangeResult =
  | { status: 'network_error' }
  | { status: 'malformed' }
  | { status: 'ok'; token?: string; error?: string };

/** Injectable dependencies so the handler can be exercised without real network/crypto. */
export interface Deps {
  /** Exchange an authorization `code` for an access token. */
  exchangeToken: (url: string, body: Record<string, unknown>) => Promise<ExchangeResult>;
  /** Generate the CSRF token (32 lowercase hex chars in production). */
  generateCsrfToken: () => string;
}

/**
 * Escape the given string for safe use in a regular expression.
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 */
export const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Test whether `domain` is allowed by the comma-separated `ALLOWED_DOMAINS` list.
 *
 * Each entry is trimmed, regex-escaped, then its first literal `*` becomes `.+`, and the result is
 * anchored with `^…$`. An empty/unset list allows everything — matching upstream behaviour.
 */
export const isAllowedDomain = (domain: string | undefined, allowedDomains?: string): boolean => {
  if (!allowedDomains) {
    return true;
  }

  return allowedDomains.split(/,/).some((str) =>
    // Escape the input, then replace a wildcard for regex (first `*` only, like upstream).
    Boolean((domain ?? '').match(new RegExp(`^${escapeRegExp(str.trim()).replace('\\*', '.+')}$`))),
  );
};

/**
 * Build the HTML response that communicates with the window opener via `postMessage`.
 * This is the exact Sveltia/Decap handshake contract and must not change.
 */
export const outputHTML = ({
  provider = 'unknown',
  token,
  error,
  errorCode,
}: {
  provider?: string;
  token?: string;
  error?: string;
  errorCode?: string;
}): Response => {
  const state = error ? 'error' : 'success';
  const content = error ? { provider, error, errorCode } : { provider, token };

  return new Response(
    `
      <!doctype html><html><body><script>
        (() => {
          window.addEventListener('message', ({ data, origin }) => {
            if (data === 'authorizing:${provider}') {
              window.opener?.postMessage(
                'authorization:${provider}:${state}:${JSON.stringify(content)}',
                origin
              );
            }
          });
          window.opener?.postMessage('authorizing:${provider}', '*');
        })();
      </script></body></html>
    `,
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        // Delete CSRF token
        'Set-Cookie': 'csrf-token=deleted; HttpOnly; Max-Age=0; Path=/; SameSite=Lax; Secure',
      },
    },
  );
};

/**
 * Handle the `auth` request — the first step in the authorization flow. Validates the provider and
 * domain, sets the CSRF cookie, and 302-redirects to the provider's authorize endpoint.
 */
export const handleAuth = async (request: Request, env: Env, deps: Deps): Promise<Response> => {
  const { url } = request;
  const { origin, searchParams } = new URL(url);
  const { provider, site_id: domain } = Object.fromEntries(searchParams);

  if (!provider || !supportedProviders.includes(provider as Provider)) {
    return outputHTML({
      error: 'Your Git backend is not supported by the authenticator.',
      errorCode: 'UNSUPPORTED_BACKEND',
    });
  }

  const {
    ALLOWED_DOMAINS,
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    GITHUB_HOSTNAME = 'github.com',
    GITLAB_CLIENT_ID,
    GITLAB_CLIENT_SECRET,
    GITLAB_HOSTNAME = 'gitlab.com',
  } = env;

  // Check if the domain is whitelisted
  if (!isAllowedDomain(domain, ALLOWED_DOMAINS)) {
    return outputHTML({
      provider,
      error: 'Your domain is not allowed to use the authenticator.',
      errorCode: 'UNSUPPORTED_DOMAIN',
    });
  }

  // Generate a random string for CSRF protection
  const csrfToken = deps.generateCsrfToken();
  let authURL = '';

  // GitHub
  if (provider === 'github') {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return outputHTML({
        provider,
        error: 'OAuth app client ID or secret is not configured.',
        errorCode: 'MISCONFIGURED_CLIENT',
      });
    }

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: 'repo,user',
      state: csrfToken,
    });

    authURL = `https://${GITHUB_HOSTNAME}/login/oauth/authorize?${params.toString()}`;
  }

  // GitLab
  if (provider === 'gitlab') {
    if (!GITLAB_CLIENT_ID || !GITLAB_CLIENT_SECRET) {
      return outputHTML({
        provider,
        error: 'OAuth app client ID or secret is not configured.',
        errorCode: 'MISCONFIGURED_CLIENT',
      });
    }

    const params = new URLSearchParams({
      client_id: GITLAB_CLIENT_ID,
      redirect_uri: `${origin}/callback`,
      response_type: 'code',
      scope: 'api',
      state: csrfToken,
    });

    authURL = `https://${GITLAB_HOSTNAME}/oauth/authorize?${params.toString()}`;
  }

  // Redirect to the authorization server
  return new Response('', {
    status: 302,
    headers: {
      Location: authURL,
      // Cookie expires in 10 minutes; Use `SameSite=Lax` to make sure the cookie is sent by the
      // browser after redirect
      'Set-Cookie': `csrf-token=${provider}_${csrfToken}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax; Secure`,
    },
  });
};

/**
 * Handle the `callback` request — the second step in the flow. Verifies the CSRF state, exchanges
 * the code for an access token, and returns the postMessage HTML page.
 */
export const handleCallback = async (request: Request, env: Env, deps: Deps): Promise<Response> => {
  const { url, headers } = request;
  const { origin, searchParams } = new URL(url);
  const { code, state } = Object.fromEntries(searchParams);

  const [, provider, csrfToken] =
    headers.get('Cookie')?.match(/\bcsrf-token=([a-z-]+?)_([0-9a-f]{32})\b/) ?? [];

  if (!provider || !supportedProviders.includes(provider as Provider)) {
    return outputHTML({
      error: 'Your Git backend is not supported by the authenticator.',
      errorCode: 'UNSUPPORTED_BACKEND',
    });
  }

  if (!code || !state) {
    return outputHTML({
      provider,
      error: 'Failed to receive an authorization code. Please try again later.',
      errorCode: 'AUTH_CODE_REQUEST_FAILED',
    });
  }

  if (!csrfToken || state !== csrfToken) {
    return outputHTML({
      provider,
      error: 'Potential CSRF attack detected. Authentication flow aborted.',
      errorCode: 'CSRF_DETECTED',
    });
  }

  const {
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    GITHUB_HOSTNAME = 'github.com',
    GITLAB_CLIENT_ID,
    GITLAB_CLIENT_SECRET,
    GITLAB_HOSTNAME = 'gitlab.com',
  } = env;

  let tokenURL = '';
  let requestBody: Record<string, unknown> = {};

  // GitHub
  if (provider === 'github') {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return outputHTML({
        provider,
        error: 'OAuth app client ID or secret is not configured.',
        errorCode: 'MISCONFIGURED_CLIENT',
      });
    }

    tokenURL = `https://${GITHUB_HOSTNAME}/login/oauth/access_token`;
    requestBody = {
      code,
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
    };
  }

  // GitLab
  if (provider === 'gitlab') {
    if (!GITLAB_CLIENT_ID || !GITLAB_CLIENT_SECRET) {
      return outputHTML({
        provider,
        error: 'OAuth app client ID or secret is not configured.',
        errorCode: 'MISCONFIGURED_CLIENT',
      });
    }

    tokenURL = `https://${GITLAB_HOSTNAME}/oauth/token`;
    requestBody = {
      code,
      client_id: GITLAB_CLIENT_ID,
      client_secret: GITLAB_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: `${origin}/callback`,
    };
  }

  const result = await deps.exchangeToken(tokenURL, requestBody);

  if (result.status === 'network_error') {
    return outputHTML({
      provider,
      error: 'Failed to request an access token. Please try again later.',
      errorCode: 'TOKEN_REQUEST_FAILED',
    });
  }

  if (result.status === 'malformed') {
    return outputHTML({
      provider,
      error: 'Server responded with malformed data. Please try again later.',
      errorCode: 'MALFORMED_RESPONSE',
    });
  }

  return outputHTML({ provider, token: result.token, error: result.error });
};

/**
 * Handle `GET /` — the front-door. When `CMS_ADMIN_URL` is set it 302-redirects there (the CMS
 * admin page). With no auth logic here: in production this route sits behind Authentik
 * forward-auth, which authenticates upstream. When unset, returns a minimal 200 health body.
 */
export const handleRoot = (env: Env): Response => {
  if (env.CMS_ADMIN_URL) {
    return new Response('', {
      status: 302,
      headers: { Location: env.CMS_ADMIN_URL },
    });
  }

  return new Response('sveltia-cms-auth OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
  });
};

/**
 * The main request handler. Mirrors the upstream Worker routing table, plus the `GET /` front-door.
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 * @see https://docs.gitlab.com/ee/api/oauth2.html#authorization-code-flow
 */
export const handleRequest = async (request: Request, env: Env, deps: Deps): Promise<Response> => {
  const { method, url } = request;
  const { pathname } = new URL(url);

  if (method === 'GET' && pathname === '/') {
    return handleRoot(env);
  }

  if (method === 'GET' && ['/auth', '/oauth/authorize'].includes(pathname)) {
    return handleAuth(request, env, deps);
  }

  if (method === 'GET' && ['/callback', '/oauth/redirect'].includes(pathname)) {
    return handleCallback(request, env, deps);
  }

  return new Response('', { status: 404 });
};

/**
 * Default token exchange: POST the request body as JSON and parse the provider's JSON response.
 * Distinguishes network failures from malformed payloads so the handler can map each to the
 * correct error code.
 */
export const defaultExchangeToken = async (
  url: string,
  body: Record<string, unknown>,
): Promise<ExchangeResult> => {
  let response: Response | undefined;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'network_error' };
  }

  if (!response) {
    return { status: 'network_error' };
  }

  let data: { access_token?: string; error?: string };

  try {
    data = (await response.json()) as { access_token?: string; error?: string };
  } catch {
    return { status: 'malformed' };
  }

  return { status: 'ok', token: data.access_token, error: data.error };
};

/** Production CSRF token generator: a UUID with the dashes stripped (32 lowercase hex chars). */
export const defaultGenerateCsrfToken = (): string =>
  globalThis.crypto.randomUUID().replaceAll('-', '');

/** Default dependency set wired to the real network and crypto. */
export const defaultDeps: Deps = {
  exchangeToken: defaultExchangeToken,
  generateCsrfToken: defaultGenerateCsrfToken,
};
