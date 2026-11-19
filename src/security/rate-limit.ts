/**
 * Rate limiting en memoria con ventana fija.
 *
 * La interfaz `RateLimiter` permite sustituir esta implementación por Redis
 * sin tocar rutas ni servicio. El tope de entradas y la limpieza periódica
 * evitan que un atacante con muchas IPs (por ejemplo un /64 IPv6) infle la
 * memoria del proceso.
 */

export const DEFAULT_RATE_LIMIT_MAX_ENTRIES = 100_000;
export const DEFAULT_RATE_LIMIT_CLEANUP_MS = 60_000;

export type RateLimitRule = {
  /** Nombre estable para la clave y para diagnosticar qué regla rechazó. */
  name: string;
  limit: number;
  windowMs: number;
};

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export type RateLimitRejection = {
  rule: string;
  retryAfterSeconds: number;
};

export type RateLimiter = {
  consume(key: string, rule: RateLimitRule, nowMs?: number): RateLimitDecision;
  cleanup(nowMs?: number): void;
  close(): void;
  readonly size: number;
};

export type MemoryRateLimiterOptions = {
  maxEntries?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
};

type Bucket = {
  count: number;
  resetAtMs: number;
};

/** Límites del plan: 5/min, 30/h y 100/día por IP. */
export const DEFAULT_CREATE_IP_RULES: readonly RateLimitRule[] = [
  { name: 'minute', limit: 5, windowMs: 60_000 },
  { name: 'hour', limit: 30, windowMs: 3_600_000 },
  { name: 'day', limit: 100, windowMs: 86_400_000 },
];

/**
 * Freno global para que muchas IPs no inunden la única instancia. Se mide en
 * creaciones *intentadas tras validar*: 2000/h cubre un pico de tráfico real
 * sin dejar la instancia (una sola, always-on) sin margen.
 */
export const DEFAULT_CREATE_GLOBAL_RULES: readonly RateLimitRule[] = [
  { name: 'global-hour', limit: 2_000, windowMs: 3_600_000 },
];

/**
 * Freno general para peticiones mutantes (POST/PUT/PATCH/DELETE), aplicado
 * antes de parsear el cuerpo. 120/min por IP deja sitio a formularios y API
 * humanos, pero corta un flood de cuerpos grandes antes de que consuman JSON
 * parser, validación o DB.
 */
export const DEFAULT_REQUEST_IP_RULES: readonly RateLimitRule[] = [
  { name: 'minute', limit: 120, windowMs: 60_000 },
];

/**
 * Lecturas públicas de metadata (`GET /api/v1/links/:alias` y `GET /?created=`).
 * Cada una cuesta una consulta a la DB y expone destino y clics, así que se
 * limitan aparte de los redirects: 60/min por IP basta para uso humano y
 * frena la enumeración de aliases.
 */
export const DEFAULT_LOOKUP_IP_RULES: readonly RateLimitRule[] = [
  { name: 'minute', limit: 60, windowMs: 60_000 },
];

/** La ruta más caliente: 300 redirects/min por IP. */
export const DEFAULT_REDIRECT_IP_RULES: readonly RateLimitRule[] = [
  { name: 'minute', limit: 300, windowMs: 60_000 },
];

export function createMemoryRateLimiter(
  options: MemoryRateLimiterOptions = {},
): RateLimiter {
  const maxEntries =
    options.maxEntries ?? DEFAULT_RATE_LIMIT_MAX_ENTRIES;
  const cleanupIntervalMs =
    options.cleanupIntervalMs ?? DEFAULT_RATE_LIMIT_CLEANUP_MS;
  const now = options.now ?? (() => Date.now());

  const buckets = new Map<string, Bucket>();
  let timer: NodeJS.Timeout | null = null;

  function cleanup(nowMs = now()): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAtMs <= nowMs) {
        buckets.delete(key);
      }
    }
  }

  function evictIfNeeded(): void {
    while (buckets.size > maxEntries) {
      const oldestKey = buckets.keys().next();

      if (oldestKey.done) return;

      buckets.delete(oldestKey.value);
    }
  }

  if (cleanupIntervalMs > 0) {
    timer = setInterval(() => cleanup(), cleanupIntervalMs);
    timer.unref();
  }

  return {
    consume(key, rule, nowMs) {
      const currentMs = nowMs ?? now();
      let bucket = buckets.get(key);

      if (!bucket || currentMs >= bucket.resetAtMs) {
        buckets.delete(key);
        bucket = {
          count: 0,
          resetAtMs: currentMs + rule.windowMs,
        };
      } else {
        // Reinsertar en cada consumo mantiene un LRU real: la evicción por
        // tamaño castiga la clave que lleva más tiempo sin actividad, no solo
        // la que no ha reiniciado su ventana.
        buckets.delete(key);
      }

      buckets.set(key, bucket);
      evictIfNeeded();

      if (bucket.count >= rule.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((bucket.resetAtMs - currentMs) / 1000),
          ),
        };
      }

      bucket.count += 1;

      return {
        allowed: true,
        remaining: Math.max(0, rule.limit - bucket.count),
      };
    },

    cleanup,

    close() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    get size() {
      return buckets.size;
    },
  };
}

/**
 * Aplica varias reglas bajo una misma clave base. Devuelve la primera que
 * rechaza, con el `Retry-After` correspondiente a su ventana.
 */
export function consumeRules(
  limiter: RateLimiter,
  baseKey: string,
  rules: readonly RateLimitRule[],
  nowMs?: number,
): RateLimitRejection | null {
  for (const rule of rules) {
    const decision = limiter.consume(
      `${baseKey}:${rule.name}`,
      rule,
      nowMs,
    );

    if (!decision.allowed) {
      return {
        rule: rule.name,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }
  }

  return null;
}
