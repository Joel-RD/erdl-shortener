import type {
  Client,
  InStatement,
  ResultSet,
  Row,
} from '@libsql/client';
import type {
  LinksRepository,
  LinksTransaction,
  NewLinkRecord,
  RecentDuplicateQuery,
} from '../../domain/links/repository.js';
import type { LinkRecord } from '../../domain/links/types.js';

/**
 * Implementación SQL del puerto de enlaces.
 *
 * Todo el conocimiento de columnas, transacciones y mapeo de filas queda aquí;
 * el dominio solo ve objetos `LinkRecord`.
 */

const SELECT_COLUMNS = `
  alias, url, url_hash, domain, created_ip_hash, created_at, expires_at,
  clicks, last_clicked_at, disabled_at, disabled_reason
`;

/** Lo que comparten `Client` y `Transaction` para ejecutar sentencias. */
type SqlExecutor = {
  execute(statement: InStatement): Promise<ResultSet>;
};

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toLinkRecord(row: Row): LinkRecord {
  return {
    alias: String(row.alias),
    url: String(row.url),
    urlHash: String(row.url_hash),
    domain: String(row.domain),
    createdIpHash: nullableString(row.created_ip_hash),
    createdAt: String(row.created_at),
    expiresAt: nullableString(row.expires_at),
    clicks: Number(row.clicks),
    lastClickedAt: nullableString(row.last_clicked_at),
    disabledAt: nullableString(row.disabled_at),
    disabledReason: nullableString(row.disabled_reason),
  };
}

async function findByAlias(
  executor: SqlExecutor,
  alias: string,
): Promise<LinkRecord | null> {
  const result = await executor.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM links WHERE alias = ? LIMIT 1`,
    args: [alias],
  });

  const row = result.rows[0];
  return row ? toLinkRecord(row) : null;
}

async function findRecentDuplicate(
  executor: SqlExecutor,
  {
    urlHash,
    createdIpHash,
    expiresAt,
    since,
    currentIso,
  }: RecentDuplicateQuery,
): Promise<LinkRecord | null> {
  const result = await executor.execute({
    sql: `SELECT ${SELECT_COLUMNS}
            FROM links
           WHERE url_hash = ?
             AND created_ip_hash = ?
             AND created_at >= ?
             AND disabled_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
             AND expires_at IS ?
           ORDER BY created_at DESC
           LIMIT 1`,
    // `IS ?` compara igual que `=` pero también casa NULL con NULL: un enlace
    // permanente solo es duplicado de otra petición permanente, y uno con
    // caducidad solo de otra con exactamente la misma caducidad. Así nunca se
    // devuelve un enlace con una vida distinta a la pedida.
    args: [urlHash, createdIpHash, since, currentIso, expiresAt],
  });

  const row = result.rows[0];
  return row ? toLinkRecord(row) : null;
}

async function countActiveLinks(
  executor: SqlExecutor,
  createdIpHash: string,
  currentIso: string,
): Promise<{ total: number; nextExpiresAt: string | null }> {
  const result = await executor.execute({
    sql: `SELECT COUNT(*) AS total,
                 MIN(CASE WHEN expires_at IS NOT NULL THEN expires_at END)
                   AS next_expires_at
            FROM links
           WHERE created_ip_hash = ?
             AND disabled_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`,
    args: [createdIpHash, currentIso],
  });

  const row = result.rows[0];

  return {
    total: Number(row?.total ?? 0),
    nextExpiresAt: nullableString(row?.next_expires_at),
  };
}

async function insert(executor: SqlExecutor, link: NewLinkRecord): Promise<void> {
  await executor.execute({
    sql: `INSERT INTO links
            (alias, url, url_hash, domain, created_ip_hash,
             created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      link.alias,
      link.url,
      link.urlHash,
      link.domain,
      link.createdIpHash,
      link.createdAt,
      link.expiresAt,
    ],
  });
}

function transactionApi(executor: SqlExecutor): LinksTransaction {
  return {
    findByAlias: (alias) => findByAlias(executor, alias),
    findRecentDuplicate: (query) => findRecentDuplicate(executor, query),
    countActiveLinks: (createdIpHash, currentIso) =>
      countActiveLinks(executor, createdIpHash, currentIso),
    insert: (link) => insert(executor, link),
  };
}

async function update(
  executor: SqlExecutor,
  sql: string,
  args: (string | number | null)[],
): Promise<number> {
  const result = await executor.execute({ sql, args });
  return result.rowsAffected;
}

export function createLinksRepository(db: Client): LinksRepository {
  return {
    findByAlias: (alias) => findByAlias(db, alias),

    async withWriteTransaction(fn) {
      const transaction = await db.transaction('write');

      try {
        const result = await fn(transactionApi(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        try {
          await transaction.rollback();
        } catch {
          // La transacción pudo cerrarse ya al fallar la sentencia.
        }

        throw error;
      } finally {
        transaction.close();
      }
    },

    disable: (alias, disabledAt, reason) =>
      update(
        db,
        `UPDATE links
            SET disabled_at = ?, disabled_reason = ?
          WHERE alias = ?
            AND disabled_at IS NULL`,
        [disabledAt, reason, alias],
      ),

    disableByDomain: (domain, disabledAt, reason) =>
      update(
        db,
        `UPDATE links
            SET disabled_at = ?, disabled_reason = ?
          WHERE domain = ?
            AND disabled_at IS NULL`,
        [disabledAt, reason, domain],
      ),
  };
}
