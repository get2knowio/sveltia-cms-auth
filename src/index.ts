/**
 * Bun entry point. Wraps the framework-agnostic `handleRequest` with `Bun.serve`, injecting the
 * process environment and the real network/crypto dependencies.
 */
import { type Env, defaultDeps, handleRequest } from './handler';

const env = process.env as Env;

const port = Number(env.PORT ?? 3000);
const hostname = env.HOST ?? '0.0.0.0';

const server = Bun.serve({
  port,
  hostname,
  fetch: (request) => handleRequest(request, env, defaultDeps),
});

// eslint-disable-next-line no-console
console.log(`sveltia-cms-auth listening on http://${server.hostname}:${server.port}`);
