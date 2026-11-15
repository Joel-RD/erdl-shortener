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
  DEFAULT_REQUEST_IP_RULES,
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
import {
  enforceRequestRateLimits,
  getClientIpHash,
  setRetryAfter,
  wantsHtml,
} from './routes/shared.js';
import { renderErrorPage } from './ui/pages.js';
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
  const requestIpRules =
    options.limits?.requestIp ?? DEFAULT_REQUEST_IP_RULES;

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
      // HSTS solo tiene sentido detrás de HTTPS real; en local/test rompería
      // http://localhost y los tests de supertest.
      ...(config.isProduction ? {} : { strictTransportSecurity: false }),
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
        ignore: (req) =>
          req.url?.split('?')[0] === '/health' ||
          req.url?.split('?')[0] === '/ready',
      },
    }),
  );

  // Freno de peticiones mutantes ANTES de los body parsers: un flood de
  // cuerpos grandes no debe llegar a express.json ni a la validación.
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }

    const limited = enforceRequestRateLimits(
      rateLimiter,
      getClientIpHash(req, ipHashSecret),
      requestIpRules,
      now().getTime(),
    );

    if (!limited) {
      next();
      return;
    }

    setRetryAfter(res, limited);

    if (wantsHtml(req) && !req.path.startsWith('/api/')) {
      res
        .status(429)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderErrorPage({
            status: 429,
            title: 'Demasiadas peticiones',
            message:
              'Has hecho demasiadas peticiones seguidas. Espera un momento y vuelve a intentarlo.',
            abuseContactEmail,
          }),
        );
      return;
    }

    res
      .status(429)
      .set('Cache-Control', 'no-store')
      .json({
        error: 'rate_limited',
        message: 'Demasiadas peticiones. Inténtalo de nuevo más tarde.',
        retryAfter: limited.retryAfterSeconds,
      });
  });

  app.use(express.json({ limit: '16kb' }));

  // La API solo acepta JSON. Sin esto, un formulario urlencoded llegaría como
  // `{}` y el error sería un 400 confuso (o peor: un 201 con otro parser).
  app.use('/api/v1', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      next();
      return;
    }

    const contentType = (req.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();

    if (contentType !== 'application/json') {
      res.set('Cache-Control', 'no-store').status(415).json({
        error: 'unsupported_media_type',
        message: 'La API solo acepta application/json.',
      });
      return;
    }

    next();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', async (req, res) => {
    // Un 200 de /health dice que el proceso vive; /ready además comprueba que
    // la DB responde. El timeout evita que Render espere al cliente libSQL.
    let timer: NodeJS.Timeout | undefined;

    try {
      const probe = db.execute('SELECT 1');
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ready_timeout')), 2_000);
        timer.unref();
      });

      await Promise.race([probe, timeout]);
      res.status(200).json({ status: 'ready' });
    } catch (error) {
      req.log?.error?.({ err: error }, 'readiness_failed');
      res.status(503).json({ status: 'unavailable' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
      // Un 4xx suele venir de un parser o de un middleware de Express con
      // `body`/`raw` adjuntos. Loguear solo el contrato evita filtrar el
      // cuerpo (posibles secretos) y mantiene la línea pequeña.
      const type =
        typeof err === 'object' && err !== null && 'type' in err
          ? String((err as { type?: unknown }).type)
          : 'unknown';
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: unknown }).message).slice(0, 200)
          : 'unknown';

      req.log.warn({ type, status, message }, 'request_error');
    }

    if (res.headersSent) {
      next(err);
      return;
    }

    res.set('Cache-Control', 'no-store');

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

    const errorCode =
      status === 413
        ? 'payload_too_large'
        : status === 415
          ? 'unsupported_media_type'
          : status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : status === 400
                ? 'bad_request'
                : status >= 500
                  ? 'internal_error'
                  : 'bad_request';

    res.status(status).json({ error: errorCode });
  };

  app.use(errorHandler);

  return app;
}
