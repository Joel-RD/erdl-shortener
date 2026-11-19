import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { stdSerializers } from 'pino';
import { pinoHttp } from 'pino-http';

/** Log de peticiones con la IP cruda redactada. */
export function createHttpLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    serializers: {
      // La IP solo se guarda como HMAC con retención limitada. El serializer
      // por defecto añadiría `remoteAddress` y `remotePort` en claro a cada
      // línea de log, fuera de esa retención.
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
  });
}
