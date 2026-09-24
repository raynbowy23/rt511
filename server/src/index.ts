/** Entry point.
 *
 *   pnpm start                                  every city you have built, polled on demand
 *   pnpm start --regions oakland-ca,des-moines-ia    those cities, polled from the start
 *
 * With no --regions, every built city is loaded so the national map and all the city maps work, but no camera is polled until you open one. Opening a city starts its cameras; leaving it stops them again. That keeps a default launch at zero request rate instead of guessing which city you meant.
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { DEFAULT_RING } from './poller.js';

interface Args {
  /** Empty means every built city, polled on demand. */
  regions: string;
  port: number;
  host: string;
  cameras: string;
  concurrency: number;
  ring: number;
  root: string;
}

function parseArgs(argv: string[]): Args {
  const here = dirname(fileURLToPath(import.meta.url));
  const args: Args = {
    regions: '',
    port: 8511,
    host: '127.0.0.1',
    cameras: 'all',
    concurrency: 4,
    ring: DEFAULT_RING,
    // dist/server/src/index.js sits four levels below the repository root; running from source sits two.
    root: resolve(here, here.includes(`${'dist'}/`) || here.includes(`${'dist'}\\`) ? '../../../..' : '../..'),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--regions' && value) args.regions = value;
    else if (flag === '--port' && value) args.port = Number(value);
    else if (flag === '--host' && value) args.host = value;
    else if (flag === '--cameras' && value) args.cameras = value;
    else if (flag === '--concurrency' && value) args.concurrency = Number(value);
    else if (flag === '--ring' && value) args.ring = Number(value);
    else if (flag === '--root' && value) args.root = resolve(value);
    else continue;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Keys live in .env, which is gitignored and read here rather than anywhere deeper, so that exactly one place in the process knows where they come from. A missing file is the ordinary case: every key is optional and the service says at startup what it is doing without each one.
const envFile = join(args.root, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    console.warn(`could not read ${envFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const app = createApp({
  root: args.root,
  regionKeys: args.regions.split(',').map((key) => key.trim()).filter(Boolean),
  pollOnDemand: args.regions.trim() === '',
  cameras: args.cameras,
  concurrency: args.concurrency,
  ring: args.ring,
});

const server = createServer((req, res) => void app.router.handle(req, res));

// Without this, a busy port throws an unhandled 'error' event and prints a stack trace, which buries the one fact that matters.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${args.port} is already in use, so rt511 cannot start.`);
    console.error('Either something else is on it, or an rt511 server is already running.');
    console.error(`  lsof -i :${args.port}          see what has it`);
    console.error(`  pnpm start --port ${args.port + 1}   use a different port`);
  } else if (error.code === 'EACCES') {
    console.error(`Not allowed to listen on ${args.host}:${args.port}. Ports below 1024 need privileges.`);
  } else {
    console.error(`Could not start the server: ${error.message}`);
  }
  app.stop();
  process.exit(1);
});

server.listen(args.port, args.host, () => {
  console.log(`rt511 server on http://${args.host}:${args.port} (root ${args.root})`);
  if (args.regions.trim() === '') {
    console.log('all built cities loaded with sparse national radar; opening a city enables its normal polling tiers');
  } else {
    app.poller.start();
  }
});

const shutdown = (): void => {
  app.stop();
  server.close(() => process.exit(0));
  // A held-open keep-alive connection should not stop the process from going.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
