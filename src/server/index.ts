// ---------------------------------------------------------------------------
// Express API server + static dashboard serving
// ---------------------------------------------------------------------------

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketManager } from './websocket.js';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { Database } from '../storage/database.js';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createAppServer(orchestrator: Orchestrator, db: Database) {
  const app = express();
  const server = createServer(app);
  const wsManager = new WebSocketManager(server);

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Serve the dashboard (static files)
  app.use(express.static(join(__dirname, '../../dashboard')));

  // ---- API Routes ----

  /** GET /api/jobs — paginated job listings */
  app.get('/api/jobs', (req, res) => {
    try {
      const {
        limit = '50',
        offset = '0',
        source,
        search,
        sortBy = 'scraped_at',
        sortOrder = 'desc',
      } = req.query;

      const result = db.getJobs({
        limit: Math.min(parseInt(String(limit), 10) || 50, 200),
        offset: parseInt(String(offset), 10) || 0,
        source: source ? String(source) : undefined,
        search: search ? String(search) : undefined,
        sortBy: String(sortBy),
        sortOrder: String(sortOrder) as 'asc' | 'desc',
      });

      res.json({
        ok: true,
        data: result.jobs,
        pagination: {
          total: result.total,
          limit: parseInt(String(limit), 10) || 50,
          offset: parseInt(String(offset), 10) || 0,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to fetch jobs' });
    }
  });

  /** GET /api/jobs/:id — single job detail */
  app.get('/api/jobs/:id', (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ ok: false, error: 'Job not found' });
      return;
    }
    res.json({ ok: true, data: job });
  });

  /** GET /api/stats — dashboard stats */
  app.get('/api/stats', (_req, res) => {
    try {
      const stats = db.getJobStats();
      const health = orchestrator.getHealthData();
      const adapters = orchestrator.getAdapters();
      const scheduler = orchestrator.getSchedulerStatus();
      const rateLimiters = orchestrator.getRateLimiterStatus();

      res.json({
        ok: true,
        data: {
          jobs: stats,
          health,
          adapters,
          scheduler,
          rateLimiters,
          wsClients: wsManager.clientCount,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to fetch stats' });
    }
  });

  /** GET /api/health — system health */
  app.get('/api/health', (_req, res) => {
    const health = orchestrator.getHealthData();
    const overallState = health.every(h => h.state === 'CLOSED')
      ? 'HEALTHY'
      : health.some(h => h.state === 'OPEN')
        ? 'DEGRADED'
        : 'PARTIAL';

    res.json({
      ok: true,
      data: {
        status: overallState,
        sources: health,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
    });
  });

  /** GET /api/runs — scrape run history */
  app.get('/api/runs', (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit || '20'), 10);
      const runs = db.getRuns(Math.min(limit, 100));
      res.json({ ok: true, data: runs });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to fetch runs' });
    }
  });

  /** POST /api/scrape — manually trigger a scrape */
  app.post('/api/scrape', async (_req, res) => {
    try {
      res.json({ ok: true, message: 'Scrape triggered' });
      // Fire and forget — results stream via WebSocket
      orchestrator.scrapeAll().catch(() => {});
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to trigger scrape' });
    }
  });

  /** GET /api/adapters — list registered source adapters */
  app.get('/api/adapters', (_req, res) => {
    const adapters = orchestrator.getAdapters();
    res.json({ ok: true, data: adapters });
  });

  // Fallback: serve dashboard for any non-API route
  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, '../../dashboard/index.html'));
  });

  // ---- Wire orchestrator events to WebSocket ----
  orchestrator.on('event', (event) => {
    wsManager.broadcast(event);
  });

  return { app, server, wsManager };
}
