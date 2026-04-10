import { REST, Routes } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import { logger } from './logger.js';
import { createBot } from './bot.js';
import { commandData } from './commands/index.js';

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(Routes.applicationCommands(config.clientId), {
      body: [commandData]
    });
    logger.ok('slash commands registered', { count: 1 });
  } catch (err) {
    logger.error('failed to register slash commands', {
      err: err.message,
      stack: err.stack
    });
    throw err;
  }
}

async function main() {
  logger.info('starting soundboard bot', {
    node: process.version,
    env: process.env.NODE_ENV || 'development'
  });

  // Log voice dependency report so we can spot missing sodium/opus fast
  const depReport = generateDependencyReport();
  logger.info('voice dependency report:\n' + depReport);

  await registerSlashCommands();

  const client = createBot();
  await client.login(config.token);

  const shutdown = signal => {
    logger.info(`${signal} received, shutting down`);
    try {
      client.destroy();
    } catch (err) {
      logger.error('client destroy threw', { err: err.message });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', err => {
    logger.error('unhandled rejection', {
      err: err?.message || String(err),
      stack: err?.stack
    });
  });

  process.on('uncaughtException', err => {
    logger.error('uncaught exception', {
      err: err.message,
      stack: err.stack
    });
  });
}

main().catch(err => {
  logger.error('fatal error during startup', {
    err: err.message,
    stack: err.stack
  });
  process.exit(1);
});
