// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------
// Wires everything together: database, adapters, orchestrator, API server.
// ---------------------------------------------------------------------------

import { config } from './config.js';
import { Database } from './storage/database.js';
import { Orchestrator } from './engine/orchestrator.js';
import { RemoteOkAdapter } from './adapters/remoteok-adapter.js';
import { HackerNewsAdapter } from './adapters/hackernews-adapter.js';
import { createAppServer } from './server/index.js';

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   ACDYON INGESTION ENGINE v1.0.0         ║');
  console.log('  ║   Production-Grade Job Data Pipeline     ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  // 1. Initialize database
  console.log(`  [db] Initializing SQLite at ${config.dbPath}`);
  const db = new Database(config.dbPath);

  // 2. Initialize orchestrator
  const orchestrator = new Orchestrator(db);

  // 3. Register source adapters based on config
  if (config.enableRemoteOk) {
    orchestrator.registerAdapter(new RemoteOkAdapter());
    console.log('  [adapter] RemoteOK registered');
  }
  if (config.enableHackerNews) {
    orchestrator.registerAdapter(new HackerNewsAdapter());
    console.log('  [adapter] HackerNews registered');
  }

  // 4. Log all engine events
  orchestrator.on('event', (event) => {
    const data = event.data;
    if (event.type === 'log') {
      const level = String(data.level || 'info').toUpperCase().padEnd(5);
      console.log(`  [${level}] ${data.message}`);
    } else if (event.type === 'job:new') {
      const job = data.job as { title: string; company: string; source: string };
      console.log(`  [JOB  ] ${job.title} @ ${job.company} (${job.source})`);
    }
  });

  // 5. Start API server
  const { server } = createAppServer(orchestrator, db);

  server.listen(config.port, () => {
    console.log('');
    console.log(`  ┌──────────────────────────────────────────┐`);
    console.log(`  │  Dashboard: http://localhost:${config.port}          │`);
    console.log(`  │  API:       http://localhost:${config.port}/api      │`);
    console.log(`  │  WebSocket: ws://localhost:${config.port}/ws         │`);
    console.log(`  └──────────────────────────────────────────┘`);
    console.log('');
  });

  // 6. Start the orchestrator (begins scheduling + initial scrape)
  await orchestrator.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n  [SHUTDOWN] Graceful shutdown initiated...');
    orchestrator.stop();
    db.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
