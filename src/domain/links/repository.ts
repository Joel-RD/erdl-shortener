import type { LinkRecord } from './types.js';

/** Datos necesarios para insertar un enlace nuevo. */
export type NewLinkRecord = {
  alias: string;
  url: string;
  urlHash: string;
  domain: string;
  createdIpHash: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type ActiveLinksCount = {
  total: number;
  nextExpiresAt: string | null;
};

export type RecentDuplicateQuery = {
  urlHash: string;
  createdIpHash: string;
  expiresAt: string | null;
  since: string;
  currentIso: string;
};

/**
 * Operaciones disponibles dentro de una transacción de escritura.
 *
 * La lógica de dedupe, cuota y reintento por colisión vive en el dominio; el
 * repositorio solo expone las consultas que esa lógica necesita.
 */
export type LinksTransaction = {
  findByAlias(alias: string): Promise<LinkRecord | null>;
  findRecentDuplicate(query: RecentDuplicateQuery): Promise<LinkRecord | null>;
  countActiveLinks(
    createdIpHash: string,
    currentIso: string,
  ): Promise<ActiveLinksCount>;
  insert(link: NewLinkRecord): Promise<void>;
};

/** Puerto de persistencia de enlaces; lo implementa `infra/db`. */
export type LinksRepository = {
  findByAlias(alias: string): Promise<LinkRecord | null>;
  /**
   * Ejecuta `fn` dentro de una transacción de escritura: hace commit si
   * resuelve y rollback si lanza.
   */
  withWriteTransaction<T>(fn: (tx: LinksTransaction) => Promise<T>): Promise<T>;
  /** Devuelve cuántas filas cambió. */
  disable(alias: string, disabledAt: string, reason: string): Promise<number>;
  /** Devuelve cuántas filas cambió. */
  disableByDomain(
    domain: string,
    disabledAt: string,
    reason: string,
  ): Promise<number>;
};
