import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Carga .env si existe. En producción las variables vienen del entorno
// (Render) y dotenv nunca sobrescribe las que ya están definidas. En tests no
// se carga: la suite fija su propio entorno en vitest.config.ts.
if (process.env.NODE_ENV !== 'test') {
  loadDotenv({ quiet: true });
}

const logLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

const databaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'DATABASE_URL no puede estar vacía')
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return ['file:', 'libsql:', 'http:', 'https:', 'ws:', 'wss:'].includes(
        protocol,
      );
    } catch {
      return false;
    }
  }, 'DATABASE_URL debe usar file:, libsql:, http(s): o ws(s):');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // La base pública se normaliza a su origen (sin path ni slash final).
  BASE_URL: z
    .url()
    .refine((value) => {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    }, 'BASE_URL debe usar http o https')
    .transform((value) => new URL(value).origin),
  ADMIN_TOKEN: z
    .string()
    .min(16, 'ADMIN_TOKEN debe tener al menos 16 caracteres'),
  // Secreto independiente para HMAC de IPs (límites, cuota y dedupe).
  IP_HASH_SECRET: z
    .string()
    .min(16, 'IP_HASH_SECRET debe tener al menos 16 caracteres'),
  // Secreto para firmar el honeypot del formulario. Si no se define, se usa
  // ADMIN_TOKEN como respaldo (los mensajes HMAC están separados por dominio).
  FORM_TOKEN_SECRET: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z
      .string()
      .min(16, 'FORM_TOKEN_SECRET debe tener al menos 16 caracteres')
      .optional(),
  ),
  // Días que se conserva el HMAC de la IP antes de anonimizarlo (30–90).
  IP_RETENTION_DAYS: z.coerce.number().int().min(30).max(90).default(45),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  // 0 = sin proxy (local). En Render debe ser 1.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  // Dev/tests: file:local.db (SQLite con WAL). Prod: libsql://... (Turso).
  DATABASE_URL: databaseUrlSchema.default('file:local.db'),
  // Escape hatch consciente para producción sin Turso (p. ej. volumen local).
  // Acepta 1/true/yes/on; cualquier otra cosa es false (incluido "false").
  ALLOW_LOCAL_DB: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
        : value,
    z.boolean(),
  ).default(false),
  // Turso lo exige; en local va vacío y se normaliza a undefined.
  DATABASE_AUTH_TOKEN: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(1, 'DATABASE_AUTH_TOKEN no puede estar vacío').optional(),
  ),
  // Visible en el pie de todas las páginas para reportar abuso.
  ABUSE_CONTACT_EMAIL: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().email('ABUSE_CONTACT_EMAIL no es un correo válido').optional(),
  ),
}).superRefine((data, ctx) => {
  // Una SQLite en el disco de Render se pierde en cada deploy y no es apta
  // para una instancia efímera. Se permite solo con una decisión explícita.
  if (
    data.NODE_ENV === 'production' &&
    data.DATABASE_URL.startsWith('file:') &&
    !data.ALLOW_LOCAL_DB
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message:
        'DATABASE_URL debe ser remota en producción (usa ALLOW_LOCAL_DB=true para forzar SQLite local)',
    });
  }
});

export type Config = {
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  isProduction: boolean;
  port: number;
  baseUrl: string;
  adminToken: string;
  ipHashSecret: string;
  formTokenSecret: string | undefined;
  retentionDays: number;
  logLevel: (typeof logLevels)[number];
  trustProxy: number;
  databaseUrl: string;
  databaseAuthToken: string | undefined;
  allowLocalDb: boolean;
  abuseContactEmail: string | undefined;
};

export function parseConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.map(String).join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Configuración de entorno inválida:\n${details}`);
  }

  const data = result.data;

  return {
    nodeEnv: data.NODE_ENV,
    isProduction: data.NODE_ENV === 'production',
    port: data.PORT,
    baseUrl: data.BASE_URL,
    adminToken: data.ADMIN_TOKEN,
    ipHashSecret: data.IP_HASH_SECRET,
    formTokenSecret: data.FORM_TOKEN_SECRET,
    retentionDays: data.IP_RETENTION_DAYS,
    logLevel: data.LOG_LEVEL,
    trustProxy: data.TRUST_PROXY,
    databaseUrl: data.DATABASE_URL,
    databaseAuthToken: data.DATABASE_AUTH_TOKEN,
    allowLocalDb: data.ALLOW_LOCAL_DB,
    abuseContactEmail: data.ABUSE_CONTACT_EMAIL,
  };
}

// Se evalúa al importar el módulo: si falta una variable requerida, el proceso
// falla antes de abrir un puerto o aceptar tráfico.
export const config = parseConfig();
