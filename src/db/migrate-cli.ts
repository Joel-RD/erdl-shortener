import { config } from '../config.js';
import { logger } from '../logger.js';
import { configureDatabase, createDatabaseClient } from './client.js';
import { baselineMigrations, runMigrations } from './migrate.js';

/**
 * Utilidades de base de datos para ejecutar fuera del servidor (Render
 * `preDeployCommand`, CI o terminal). Usa el mismo entorno que la app.
 *
 *   node dist/db/migrate-cli.js migrate
 *   node dist/db/migrate-cli.js baseline [--dry-run]
 */
async function main(): Promise<void> {
  const [command = 'migrate', ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');

  const client = createDatabaseClient({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken,
  });

  try {
    await configureDatabase(client);

    if (command === 'migrate') {
      const appliedMigrations = await runMigrations(client);
      logger.info({ appliedMigrations }, 'database_ready');
      return;
    }

    if (command === 'baseline') {
      const result = await baselineMigrations(client, { dryRun });

      if (result.pending.length > 0) {
        logger.error(
          { pending: result.pending },
          'baseline_incomplete_schema',
        );
      }

      logger.info(
        { dryRun: result.dryRun, recorded: result.recorded },
        result.dryRun ? 'baseline_dry_run' : 'baseline_complete',
      );

      // Un esquema incompleto no debe darse por bueno en un pipeline.
      if (result.pending.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    throw new Error(
      `Comando desconocido: ${command}. Usa "migrate" o "baseline" [--dry-run].`,
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, 'db_command_failed');
  process.exitCode = 1;
});
