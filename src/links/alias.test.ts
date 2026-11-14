import { describe, expect, it } from 'vitest';
import {
  generateAlias,
  isReservedAlias,
  validateCustomAlias,
} from './alias.js';

describe('generateAlias', () => {
  it('genera 7 caracteres base62', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateAlias()).toMatch(/^[0-9A-Za-z]{7}$/);
    }
  });

  it('admite otra longitud y no repite en una muestra corta', () => {
    const aliases = new Set(
      Array.from({ length: 200 }, () => generateAlias(12)),
    );

    expect(aliases.size).toBeGreaterThan(190);
    for (const alias of aliases) {
      expect(alias).toMatch(/^[0-9A-Za-z]{12}$/);
    }
  });
});

describe('validateCustomAlias', () => {
  it('acepta letras, números, guion y guion bajo', () => {
    const result = validateCustomAlias('mi-enlace_2026');

    expect(result).toEqual({ ok: true, alias: 'mi-enlace_2026' });
  });

  it('recorta espacios exteriores', () => {
    const result = validateCustomAlias('  mi-enlace  ');

    expect(result).toEqual({ ok: true, alias: 'mi-enlace' });
  });

  it.each(['ab', 'a'.repeat(33), 'con espacio', 'con/punto', 'acentué'])(
    'rechaza el formato %s',
    (alias) => {
      const result = validateCustomAlias(alias);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('alias_invalid');
    },
  );

  it.each(['api', 'API', 'admin', 'health', 'static', 'styles.css'])(
    'rechaza el alias reservado %s',
    (alias) => {
      const result = validateCustomAlias(alias);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Los que llevan punto tampoco pasan el formato.
        expect(['alias_reserved', 'alias_invalid']).toContain(result.code);
      }
    },
  );

  it('compara los reservados sin distinguir mayúsculas', () => {
    expect(isReservedAlias('HeAlTh')).toBe(true);
    expect(isReservedAlias('mi-alias')).toBe(false);
  });
});
