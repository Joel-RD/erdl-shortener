import type { RequestHandler } from 'express';
import helmet from 'helmet';

/** Cabeceras de seguridad y CSP estricta (sin scripts inline). */
export function createSecurityHeaders(
  isProduction: boolean,
): RequestHandler {
  return helmet({
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
    ...(isProduction ? {} : { strictTransportSecurity: false }),
  });
}
