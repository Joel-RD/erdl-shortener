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
});
