import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Carga .env si existe. En producción las variables vienen del entorno
// (Render) y dotenv nunca sobrescribe las que ya están definidas.
loadDotenv({ quiet: true });

const logLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

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
  LOG_LEVEL: z.enum(logLevels).default('info'),
  // 0 = sin proxy (local). En Render debe ser 1.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
});

export type Config = {
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  isProduction: boolean;
  port: number;
  baseUrl: string;
  adminToken: string;
  logLevel: (typeof logLevels)[number];
  trustProxy: number;
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
    logLevel: data.LOG_LEVEL,
    trustProxy: data.TRUST_PROXY,
  };
}

// Se evalúa al importar el módulo: si falta una variable requerida, el proceso
// falla antes de abrir un puerto o aceptar tráfico.
export const config = parseConfig();
