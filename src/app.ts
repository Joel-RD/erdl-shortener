import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Logger } from 'pino';
import { createAliasCache, type AliasCache } from './infra/cache/alias-cache.js';
import {
  createClickBuffer,
  type ClickBuffer,
} from './infra/clicks/click-buffer.js';
import { db as defaultDb, type DatabaseClient } from './infra/db/client.js';
import { createBlocklistStore } from './infra/db/blocklist-store.js';
import { createLinksRepository } from './infra/db/links-repository.js';
import {
  createMemoryRateLimiter,
  DEFAULT_CREATE_GLOBAL_RULES,
  DEFAULT_CREATE_IP_RULES,
  DEFAULT_LOOKUP_IP_RULES,
  DEFAULT_REDIRECT_IP_RULES,
  DEFAULT_REQUEST_IP_RULES,
  type RateLimiter,
  type RateLimitRule,
} from './security/rate-limit.js';
import { config } from './config.js';
import { createLinkService } from './domain/links/service.js';
import { createAdminRouter } from './http/routes/api-admin.js';
import { createApiLinksRouter } from './http/routes/api-links.js';
import { createPagesRouter } from './http/routes/home.js';
import { createRedirectRouter } from './http/routes/redirect.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { requireJsonContentType } from './http/middleware/content-type.js';
import {
  createErrorHandler,
  createNotFoundHandler,
} from './http/middleware/errors.js';
import { createHttpLogger } from './http/middleware/logging.js';
import { createRequestRateLimit } from './http/middleware/rate-limits.js';
import { createSecurityHeaders } from './http/middleware/security-headers.js';
import { logger as defaultLogger } from './logger.js';

export type AppRateLimits = {
  createIp?: readonly RateLimitRule[] | undefined;
  createGlobal?: readonly RateLimitRule[] | undefined;
  redirectIp?: readonly RateLimitRule[] | undefined;
  lookupIp?: readonly RateLimitRule[] | undefined;
  requestIp?: readonly RateLimitRule[] | undefined;
};

export type AppOptions = {
  db?: DatabaseClient | undefined;
  now?: (() => Date) | undefined;
  abuseContactEmail?: string | undefined;
  cache?: AliasCache | undefined;
  clickBuffer?: ClickBuffer | undefined;
  rateLimiter?: RateLimiter | undefined;
  blocklist?: ReturnType<typeof createBlocklistStore> | undefined;
  adminToken?: string | undefined;
  formTokenSecret?: string | undefined;
  formTokenMinAgeMs?: number | undefined;
  logger?: Logger | undefined;
  ipHashSecret?: string | undefined;
  limits?: AppRateLimits | undefined;
  maxActiveLinksPerIp?: number | undefined;
  dedupeWindowMs?: number | undefined;
};

/** Piezas con estado que el arranque/apagado necesitan conocer. */
export type AppRuntime = {
  cache: AliasCache;
  clickBuffer: ClickBuffer;
  rateLimiter: RateLimiter;
  /** Vacía clics pendientes y detiene los timers. */
  close: () => Promise<void>;
};

export function getAppRuntime(app: express.Express): AppRuntime {
  return app.locals.runtime as AppRuntime;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  const db = options.db ?? defaultDb;
  const abuseContactEmail =
    options.abuseContactEmail ?? config.abuseContactEmail;
  const now = options.now ?? (() => new Date());
  const ipHashSecret = options.ipHashSecret ?? config.ipHashSecret;
  const adminToken = options.adminToken ?? config.adminToken;
  const formTokenSecret =
    options.formTokenSecret ?? config.formTokenSecret ?? adminToken;
  const httpLogger = options.logger ?? defaultLogger;

  const cache = options.cache ?? createAliasCache();
  const clickBuffer =
    options.clickBuffer ?? createClickBuffer({ db, now });
  const rateLimiter =
    options.rateLimiter ??
    createMemoryRateLimiter({ now: () => now().getTime() });
  const blocklist =
    options.blocklist ??
    createBlocklistStore({
      db,
      ownDomain: new URL(config.baseUrl).hostname,
      now,
    });

  const createIpRules =
    options.limits?.createIp ?? DEFAULT_CREATE_IP_RULES;
  const createGlobalRules =
    options.limits?.createGlobal ?? DEFAULT_CREATE_GLOBAL_RULES;
  const redirectIpRules =
    options.limits?.redirectIp ?? DEFAULT_REDIRECT_IP_RULES;
  const lookupIpRules =
    options.limits?.lookupIp ?? DEFAULT_LOOKUP_IP_RULES;
  const requestIpRules =
    options.limits?.requestIp ?? DEFAULT_REQUEST_IP_RULES;

  const service = createLinkService({
    repository: createLinksRepository(db),
    now,
    cache,
    clickBuffer,
    blocklist,
    maxActiveLinksPerIp: options.maxActiveLinksPerIp,
    dedupeWindowMs: options.dedupeWindowMs,
  });

  const runtime: AppRuntime = {
    cache,
    clickBuffer,
    rateLimiter,
    async close() {
      try {
        await clickBuffer.close();
      } finally {
        rateLimiter.close();
      }
    },
  };

  app.locals.runtime = runtime;

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 0 ? false : config.trustProxy);

  app.use(createSecurityHeaders(config.isProduction));
  app.use(createHttpLogger(httpLogger));
  app.use(
    createRequestRateLimit({
      limiter: rateLimiter,
      ipHashSecret,
      rules: requestIpRules,
      now,
      abuseContactEmail,
    }),
  );

  app.use(express.json({ limit: '16kb' }));

  app.use('/api/v1', requireJsonContentType());

  registerHealthRoutes(app, db);

  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: config.isProduction ? '1h' : 0,
    }),
  );

  app.use(
    '/api/v1',
    createAdminRouter({
      service,
      blocklist,
      adminToken,
    }),
  );
  app.use(
    '/api/v1',
    createApiLinksRouter({
      service,
      baseUrl: config.baseUrl,
      rateLimiter,
      ipHashSecret,
      createIpRules,
      createGlobalRules,
      lookupIpRules,
      now,
    }),
  );
  app.use(
    createPagesRouter({
      service,
      baseUrl: config.baseUrl,
      abuseContactEmail,
      rateLimiter,
      ipHashSecret,
      formTokenSecret,
      ...(options.formTokenMinAgeMs !== undefined
        ? { formTokenMinAgeMs: options.formTokenMinAgeMs }
        : {}),
      createIpRules,
      createGlobalRules,
      lookupIpRules,
      now,
    }),
  );
  app.use(
    createRedirectRouter({
      service,
      abuseContactEmail,
      rateLimiter,
      ipHashSecret,
      redirectIpRules,
      now,
    }),
  );

  app.use(createNotFoundHandler({ abuseContactEmail }));
  app.use(createErrorHandler({ abuseContactEmail }));

  return app;
}
