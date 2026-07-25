import { buildApp } from './app.mjs';
import { loadConfig } from './config.mjs';

const config = await loadConfig();
const { app } = await buildApp({ config });

const close = async (signal) => {
  app.log.info({ signal }, 'shutdown_requested');
  await app.close();
};
process.once('SIGTERM', () => close('SIGTERM').catch(() => process.exitCode = 1));
process.once('SIGINT', () => close('SIGINT').catch(() => process.exitCode = 1));

await app.listen({ host: '0.0.0.0', port: config.port });
