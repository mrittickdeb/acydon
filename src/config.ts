// ---------------------------------------------------------------------------
// Application configuration — loaded from environment with sensible defaults
// ---------------------------------------------------------------------------

import dotenv from 'dotenv';
import type { AppConfig } from './types.js';

dotenv.config();

function env(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim()?.toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function envList(key: string): string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export const config: AppConfig = {
  port:                       envInt('PORT', 3000),
  env:                        env('NODE_ENV', 'development'),
  scrapeIntervalMinutes:      envInt('SCRAPE_INTERVAL_MINUTES', 15),
  scrapeJitterMinutes:        envInt('SCRAPE_JITTER_MINUTES', 3),
  maxConcurrentScrapes:       envInt('MAX_CONCURRENT_SCRAPES', 2),
  rateLimitRequestsPerMinute: envInt('RATE_LIMIT_REQUESTS_PER_MINUTE', 20),
  rateLimitBurst:             envInt('RATE_LIMIT_BURST', 5),
  proxyUrls:                  envList('PROXY_URLS'),
  enableRemoteOk:             envBool('ENABLE_REMOTEOK', true),
  enableHackerNews:           envBool('ENABLE_HACKERNEWS', true),
  dbPath:                     env('DB_PATH', './data/ingestion.db'),
  logLevel:                   env('LOG_LEVEL', 'info'),
};
