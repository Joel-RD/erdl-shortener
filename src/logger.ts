import pino, { type DestinationStream, type Logger } from 'pino';
import { config } from './config.js';

/**
 * Logs estructurados. El token admin y las cookies nunca deben quedar en el
 * historial: pino los redacta antes de serializarlos.
 */

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'err.config.headers.authorization',
];

export type CreateLoggerOptions = {
  level?: string | undefined;
  destination?: DestinationStream | undefined;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions = {
    level: options.level ?? config.logLevel,
    base: { service: 'erdl-shortener' },
    redact: {
      paths: REDACTED_PATHS,
      censor: '[redacted]',
    },
  };

  return options.destination
    ? pino(pinoOptions, options.destination)
    : pino(pinoOptions);
}

export const logger = createLogger();
