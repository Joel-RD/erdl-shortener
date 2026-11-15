import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function memoryDestination(): {
  stream: Writable;
  output: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return { stream, output: () => chunks.join('') };
}

describe('createLogger', () => {
  it('redacta authorization y cookies antes de escribir', () => {
    const destination = memoryDestination();
    const logger = createLogger({
      level: 'info',
      destination: destination.stream,
    });

    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer super-secret-admin-token',
            cookie: 'session=private-cookie',
          },
        },
        res: {
          headers: {
            'set-cookie': 'session=private-cookie',
          },
        },
      },
      'request_completed',
    );

    const output = destination.output();

    expect(output).not.toContain('super-secret-admin-token');
    expect(output).not.toContain('private-cookie');
    expect(output).toContain('[redacted]');
  });

  it('redacta IPs de cabeceras, referer y cuerpos de error', () => {
    const destination = memoryDestination();
    const logger = createLogger({
      level: 'info',
      destination: destination.stream,
    });

    logger.warn(
      {
        req: {
          headers: {
            'x-forwarded-for': '203.0.113.77',
            'x-real-ip': '198.51.100.9',
            forwarded: 'for=192.0.2.1',
            referer: 'https://interno.example/privado',
          },
        },
        err: {
          type: 'entity.parse.failed',
          body: '{"password":"SEKRETO-123"}',
          raw: '{"password":"SEKRETO-123"}',
        },
      },
      'request_error',
    );

    const output = destination.output();

    for (const secret of [
      '203.0.113.77',
      '198.51.100.9',
      '192.0.2.1',
      'interno.example',
      'SEKRETO-123',
    ]) {
      expect(output).not.toContain(secret);
    }

    expect(output).toContain('[redacted]');
  });
});
