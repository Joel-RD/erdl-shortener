import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { stdSerializers } from 'pino';
import { pinoHttp } from 'pino-http';
import { createBlocklist, type Blocklist } from './abuse/blocklist.js';
import { createClickBuffer, type ClickBuffer } from './abuse/click-buffer.js';
import {
  createMemoryRateLimiter,
  DEFAULT_CREATE_GLOBAL_RULES,
  DEFAULT_CREATE_IP_RULES,
  DEFAULT_LOOKUP_IP_RULES,
  DEFAULT_REDIRECT_IP_RULES,
  type RateLimiter,
  type RateLimitRule,
} from './abuse/rate-limit.js';
import { createAliasCache, type AliasCache } from './cache/alias-cache.js';
import { config } from './config.js';
import { db as defaultDb, type DatabaseClient } from './db/client.js';
import { createLinkService } from './links/service.js';
import { createAdminRouter } from './routes/api-admin.js';
import { createApiLinksRouter } from './routes/api-links.js';
import { createPagesRouter } from './routes/pages.js';
import { createRedirectRouter } from './routes/redirect.js';
import { wantsHtml } from './routes/shared.js';
import { renderErrorPage } from './ui/pages.js';
import { logger as defaultLogger } from './logger.js';

export type AppRateLimits = {
  createIp?: readonly RateLimitRule[] | undefined;
  createGlobal?: readonly RateLimitRule[] | undefined;
  redirectIp?: readonly RateLimitRule[] | undefined;
  lookupIp?: readonly RateLimitRule[] | undefined;
};

export type AppOptions = {
  db?: DatabaseClient | undefined;
  now?: (() => Date) | undefined;
  abuseContactEmail?: string | undefined;
  cache?: AliasCache | undefined;
  clickBuffer?: ClickBuffer | undefined;
  rateLimiter?: RateLimiter | undefined;
  blocklist?: Blocklist | undefined;
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
    createBlocklist({
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

  const service = createLinkService({
    db,
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

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      xFrameOptions: { action: 'deny' },
    }),
  );

  app.use(
    pinoHttp({
      logger: httpLogger,
      serializers: {
        // La IP solo se guarda como HMAC con retención limitada. El
        // serializer por defecto añadiría `remoteAddress` y `remotePort` en
        // claro a cada línea de log, fuera de esa retención.
        req: stdSerializers.wrapRequestSerializer((serialized) => {
          const { remoteAddress: _address, remotePort: _port, ...rest } =
            serialized;

          return rest as typeof serialized;
        }),
      },
      autoLogging: {
        ignore: (req) => req.url?.split('?')[0] === '/health',
      },
    }),
  );

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

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

  app.use((req, res) => {
    if (wantsHtml(req) && !req.path.startsWith('/api/')) {
      res
        .status(404)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderErrorPage({
            status: 404,
            title: 'Página no encontrada',
            message: 'La ruta que buscas no existe en este servidor.',
            abuseContactEmail,
          }),
        );
      return;
    }

    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    const rawStatus =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: unknown }).status)
        : Number.NaN;

    const status =
      Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 500
        ? rawStatus
        : 500;

    if (status >= 500) {
      req.log.error({ err }, 'unhandled_error');
    } else {
      req.log.warn({ err, status }, 'request_error');
    }

    if (res.headersSent) {
      next(err);
      return;
    }

    if (wantsHtml(req) && !req.path.startsWith('/api/')) {
      res
        .status(status)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderErrorPage({
            status,
            title: status === 500 ? 'Algo salió mal' : 'Petición no válida',
            message:
              status === 500
                ? 'Tuvimos un problema al procesar la petición. Inténtalo de nuevo.'
                : 'La petición no se pudo procesar tal como llegó.',
            abuseContactEmail,
          }),
        );
      return;
    }

    res.status(status).json({
      error:
        status === 413
          ? 'payload_too_large'
          : status === 400
            ? 'bad_request'
            : 'internal_error',
    });
  };

  app.use(errorHandler);

  return app;
}
