import type { Client } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTempDatabase,
  type TempDatabase,
} from '../testing/temp-db.js';
import { createClickBuffer, type ClickBuffer } from './click-buffer.js';

let database: TempDatabase;
let db: Client;

async function insertLink(alias: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO links (alias, url, url_hash, domain)
          VALUES (?, ?, ?, ?)`,
    args: [
      alias,
      `https://example.com/${alias}`,
      `hash-${alias}`,
      'example.com',
    ],
  });
}

async function readClicks(
  alias: string,
): Promise<{ clicks: number; lastClickedAt: string | null }> {
  const result = await db.execute({
    sql: 'SELECT clicks, last_clicked_at FROM links WHERE alias = ?',
    args: [alias],
  });
  const row = result.rows[0];

  return {
    clicks: Number(row?.clicks ?? 0),
    lastClickedAt:
      row?.last_clicked_at === null || row?.last_clicked_at === undefined
        ? null
        : String(row.last_clicked_at),
  };
}

beforeAll(async () => {
  database = await createTempDatabase();
  db = database.client;
});

afterAll(async () => {
  await database.cleanup();
});

describe('createClickBuffer', () => {
  it('agrupa clics por alias y conserva el último timestamp', async () => {
    await insertLink('buffer-a');
    await insertLink('buffer-b');

    const buffer = createClickBuffer({ db, intervalMs: 0, maxBatch: 0 });

    buffer.record('buffer-a', new Date('2026-01-01T00:00:01.000Z'));
    buffer.record('buffer-a', new Date('2026-01-01T00:00:03.000Z'));
    buffer.record('buffer-a', new Date('2026-01-01T00:00:02.000Z'));
    buffer.record('buffer-b', new Date('2026-01-01T00:00:04.000Z'));

    expect(buffer.pendingCount).toBe(4);

    await buffer.flush();

    expect(buffer.pendingCount).toBe(0);
    expect(await readClicks('buffer-a')).toEqual({
      clicks: 3,
      lastClickedAt: '2026-01-01T00:00:03.000Z',
    });
    expect(await readClicks('buffer-b')).toEqual({
      clicks: 1,
      lastClickedAt: '2026-01-01T00:00:04.000Z',
    });
  });

  it('vacía automáticamente al alcanzar el tamaño de lote', async () => {
    await insertLink('buffer-lote');

    const buffer = createClickBuffer({ db, intervalMs: 0, maxBatch: 2 });

    buffer.record('buffer-lote', new Date('2026-01-01T00:00:01.000Z'));
    buffer.record('buffer-lote', new Date('2026-01-01T00:00:02.000Z'));

    // El flush se dispara en segundo plano; esperar al mismo in-flight.
    await buffer.flush();

    expect(await readClicks('buffer-lote')).toEqual({
      clicks: 2,
      lastClickedAt: '2026-01-01T00:00:02.000Z',
    });
  });

  it('close() detiene el timer y vacía lo pendiente', async () => {
    await insertLink('buffer-close');

    const buffer: ClickBuffer = createClickBuffer({
      db,
      intervalMs: 60_000,
    });

    buffer.record('buffer-close', new Date('2026-01-01T00:00:01.000Z'));
    await buffer.close();

    expect(await readClicks('buffer-close')).toEqual({
      clicks: 1,
      lastClickedAt: '2026-01-01T00:00:01.000Z',
    });
  });
});
