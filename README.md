# sveltia-cms-auth

An OAuth broker that lets a Git-based CMS — [Sveltia CMS](https://github.com/sveltia/sveltia-cms),
or any Netlify/Decap-compatible CMS — authenticate users with **GitHub** (and **GitLab**) for its
GitHub backend.

This is a faithful port of the Cloudflare Worker
[`sveltia/sveltia-cms-auth`](https://github.com/sveltia/sveltia-cms-auth) to a small
[Bun](https://bun.sh) HTTP server, containerized and published as a multi-arch image to
`ghcr.io/get2knowio/sveltia-cms-auth`. The OAuth handshake protocol (routes, CSRF cookie,
`postMessage` contract, error codes) is preserved exactly, so it interoperates with
Sveltia/Decap unchanged — only the Worker `fetch` handler is swapped for `Bun.serve`.

## Why a broker?

The CMS runs as a static site somewhere else (e.g. AWS Amplify). The browser cannot hold the OAuth
**client secret**, and GitHub's `code → token` exchange requires it. This broker holds the secret
and performs that exchange server-side, then hands the token back to the CMS popup via the Decap
`postMessage` handshake.

```
Browser (CMS popup) ──/auth──▶ broker ──302──▶ GitHub authorize
                                                    │
GitHub ──/callback?code&state──▶ broker ──exchange (secret)──▶ access token
                                                    │
                              broker ──postMessage──▶ CMS opener window
```

## Routes

| Method & path | Alias | Behavior |
| --- | --- | --- |
| `GET /auth` | `GET /oauth/authorize` | Validates `provider` + `site_id` against `ALLOWED_DOMAINS`, sets the CSRF cookie, 302-redirects to the provider's authorize endpoint. |
| `GET /callback` | `GET /oauth/redirect` | Verifies `state` against the CSRF cookie, exchanges `code` for an access token, returns the `postMessage` HTML page. |
| `GET /` | — | 302-redirects to `CMS_ADMIN_URL` if set (the CMS front-door), else returns `200 sveltia-cms-auth OK`. No auth logic — meant to sit behind Authentik forward-auth. |
| anything else | — | `404`. |

**Scopes:** GitHub `repo,user`; GitLab `api`. (As upstream, the GitHub authorize URL carries no
`redirect_uri` — GitHub uses the OAuth App's configured callback — while GitLab includes it.)

### `postMessage` handshake (Sveltia/Decap contract)

1. popup → opener: `authorizing:{provider}` (target origin `*`).
2. popup listens for the opener's reply.
3. popup → opener (target = the reply's origin):
   - success: `authorization:{provider}:success:` + `JSON.stringify({ provider, token })`
   - failure: `authorization:{provider}:error:` + `JSON.stringify({ provider, error, errorCode })`

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | — | **Required** (primary path). |
| `GITHUB_CLIENT_SECRET` | — | **Required** (primary path). |
| `GITHUB_HOSTNAME` | `github.com` | Override for GitHub Enterprise. |
| `GITLAB_CLIENT_ID` | — | Optional — GitLab parity. |
| `GITLAB_CLIENT_SECRET` | — | Optional — GitLab parity. |
| `GITLAB_HOSTNAME` | `gitlab.com` | |
| `ALLOWED_DOMAINS` | — | Comma-separated allow-list for `site_id`. Supports a `*` wildcard. Empty/unset allows any domain. |
| `CMS_ADMIN_URL` | — | Where `GET /` redirects. Unset ⇒ `GET /` returns a 200 health body. |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |

**`ALLOWED_DOMAINS` matching:** each comma-separated entry is trimmed, regex-escaped, its first
literal `*` becomes `.+`, then it is anchored `^…$`. So `*.example.com` matches `a.example.com`
but **not** `example.com` itself.

## GitHub OAuth App setup

Create an OAuth App (Settings → Developer settings → OAuth Apps) and set:

- **Authorization callback URL:** `https://<broker-host>/callback`

Copy the Client ID/secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

## CMS configuration

Point the CMS backend at this broker (Sveltia/Decap `config.yml`):

```yaml
backend:
  name: github
  repo: your-org/your-repo
  branch: main
  base_url: https://<broker-host>      # this broker's origin
  # auth_endpoint: oauth/authorize     # default works with /auth + /oauth/authorize
```

## Run

### Docker (from GHCR)

```bash
docker run --rm -p 3000:3000 \
  -e GITHUB_CLIENT_ID=xxxx \
  -e GITHUB_CLIENT_SECRET=yyyy \
  -e ALLOWED_DOMAINS='*.example.com' \
  -e CMS_ADMIN_URL=https://cms.example.com/admin/ \
  ghcr.io/get2knowio/sveltia-cms-auth:1.0.0
```

### Local (Bun)

```bash
bun install
cp .env.example .env   # fill in secrets
bun run start          # or: bun run dev  (watch mode)
```

## Deploying behind Authentik forward-auth (Hola)

This image is packaged as a Hola catalog app (the bundle lives separately in `try-hola/apps`).
In that deployment it sits behind Hola's **Authentik forward-auth**, which authenticates the user
upstream before any request reaches the broker. The `GET /` route is therefore a blind front-door
redirect to `CMS_ADMIN_URL` (the CMS admin page) — it intentionally contains no auth logic.

The OAuth routes (`/auth`, `/callback`, and their aliases) must remain reachable for the GitHub
handshake; the CSRF cookie + `state` check is the broker's own protection on that flow.

## Development

```bash
bun test            # unit tests (no network calls — token exchange is mocked)
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
bun run format      # biome format --write
```

Tests cover: `ALLOWED_DOMAINS` wildcard matching (incl. `*.example.com` matching `a.example.com`
but not `example.com`), the `postMessage` string formats, CSRF `state` validation, and routing.

## Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which uses QEMU + Buildx to build
`linux/amd64,linux/arm64` and push to `ghcr.io/get2knowio/sveltia-cms-auth:<version>` and `:latest`.

```bash
git tag v1.0.0
git push origin v1.0.0
```

> **Make the GHCR package public (one time).** After the first publish, open the package at
> `https://github.com/orgs/get2knowio/packages/container/sveltia-cms-auth/settings` and set its
> visibility to **Public**, so Hola can pull it anonymously.

## License

MIT — a port of [`sveltia/sveltia-cms-auth`](https://github.com/sveltia/sveltia-cms-auth)
(MIT, © Kohei Yoshino and contributors), preserving its OAuth handshake protocol.