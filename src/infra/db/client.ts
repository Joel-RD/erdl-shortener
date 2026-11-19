import { createClient, type Client } from '@libsql/client';
import { config } from '../../config.js';

export type DatabaseClient = Client;

type DatabaseOptions = {
  url: string;
  authToken?: string | undefined;
};

/** Turso no debe colgar una petición HTTP más de esto. */
const REMOTE_NETWORK_TIMEOUT_MS = 10_000;

const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(REMOTE_NETWORK_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;

  return fetch(input, { ...init, signal });
};

/**
 * Crea el cliente de libSQL. El mismo tipo de cliente sirve para SQLite local
 * (`file:local.db`) y para Turso (`libsql://...`): solo cambia la URL.
 */
export function createDatabaseClient(options: DatabaseOptions): DatabaseClient {
  const authToken = options.authToken?.trim();
  const isLocal = options.url.startsWith('file:');

  return createClient({
    url: options.url,
    // No enviar authToken vacío: en local no existe y Turso lo rechazaría.
    ...(authToken ? { authToken } : {}),
    // Si otra conexión mantiene el lock de escritura, esperar en vez de fallar.
    timeout: 5_000,
    // En remoto, un fetch colgado consume el turno de la petición hasta que
    // Render corta. AbortSignal.timeout lo convierte en un error accionable.
    ...(isLocal ? {} : { fetch: fetchWithTimeout }),
  });
}

/**
 * Ajustes por conexión que no van en las migraciones.
 *
 * - `journal_mode = WAL` permite leer mientras se escribe y sobrevive a
 *   reinicios (el modo queda grabado en el archivo).
 * - `synchronous = NORMAL` es el compañero habitual de WAL: con una instancia
 *   always-on el riesgo de perder la última transacción es aceptable.
 * - `busy_timeout` ya se configura con `timeout` en el cliente.
 */
export async function configureDatabase(
  client: DatabaseClient,
): Promise<void> {
  if (client.protocol === 'file') {
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA synchronous = NORMAL');
    await client.execute('PRAGMA foreign_keys = ON');
  }
}

// Cliente único del proceso. La conexión real se abre en la primera consulta.
export const db = createDatabaseClient({
  url: config.databaseUrl,
  authToken: config.databaseAuthToken,
});
