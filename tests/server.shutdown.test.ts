import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../src/infra/db/client.js';

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];
const clients: Client[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null
          ? address.port
          : 0;

      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `El servidor terminó antes de escuchar. Salida:\n${output()}`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { connection: 'close' },
      });

      if (response.ok) {
        await response.text();
        return;
      }
    } catch {
      // Todavía no escucha; reintentar.
    }

    await delay(100);
  }

  throw new Error(`El servidor no respondió /health. Salida:\n${output()}`);
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('El servidor no terminó tras SIGTERM'));
    }, 10_000);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  children.clear();

  for (const client of clients) {
    client.close();
  }
  clients.length = 0;

  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe('apagado limpio del servidor', () => {
  it('persiste los clics pendientes antes de cerrar con SIGTERM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'erdl-shutdown-'));
    tempDirs.push(dir);

    const databaseUrl = pathToFileURL(join(dir, 'server.db')).href;
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const chunks: string[] = [];

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          BASE_URL: baseUrl,
          ADMIN_TOKEN: 'test-admin-token-0123456789',
          IP_HASH_SECRET: 'test-ip-hash-secret-0123456789',
          DATABASE_URL: databaseUrl,
          LOG_LEVEL: 'silent',
          TRUST_PROXY: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    await waitForHealth(baseUrl, child, () => chunks.join(''));

    const created = await fetch(`${baseUrl}/api/v1/links`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({ url: 'https://example.com/apagado' }),
    });

    expect(created.status).toBe(201);

    const body = (await created.json()) as { alias?: string };
    expect(body.alias).toMatch(/^[0-9A-Za-z]{7}$/);

    const redirect = await fetch(`${baseUrl}/${body.alias}`, {
      redirect: 'manual',
      headers: { connection: 'close' },
    });
    await redirect.text();

    expect(redirect.status).toBe(302);

    child.kill('SIGTERM');

    const exit = await waitForExit(child);

    expect(exit).toEqual({ code: 0, signal: null });

    const client = createDatabaseClient({ url: databaseUrl });
    clients.push(client);

    const result = await client.execute({
      sql: 'SELECT clicks, last_clicked_at FROM links WHERE alias = ?',
      args: [body.alias ?? ''],
    });

    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0]?.clicks)).toBe(1);
    expect(String(result.rows[0]?.last_clicked_at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  }, 30_000);
});
