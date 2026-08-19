// ---------------------------------------------------------------------------
// Unified type definitions for the ingestion engine
// ---------------------------------------------------------------------------

/** Normalized job listing — the canonical shape every adapter must produce */
export interface JobListing {
  id: string;
  source: string;
  externalId: string;
  title: string;
  company: string;
  location: string;
  description: string;
  salary: SalaryRange | null;
  tags: string[];
  url: string;
  postedAt: Date;
  scrapedAt: Date;
  confidence: number; // 0-1
}

export interface SalaryRange {
  min: number;
  max: number;
  currency: string;
}

/** Raw data coming from an adapter before normalization */
export interface RawJobListing {
  source: string;
  externalId: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  salaryText?: string;
  tags?: string[];
  url?: string;
  postedAt?: string | number;
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Source adapter interfaces
// ---------------------------------------------------------------------------

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SourceHealth {
  source: string;
  state: CircuitState;
  successRate: number;      // 0-1 over rolling window
  avgResponseMs: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface DetectionProfile {
  source: string;
  risks: string[];
  mitigations: string[];
  requiresBrowser: boolean;
  hasPublicApi: boolean;
  rateLimitPerMinute: number;
}

export interface SourceAdapter {
  readonly name: string;
  scrape(): AsyncGenerator<RawJobListing>;
  healthCheck(): Promise<boolean>;
  getDetectionProfile(): DetectionProfile;
}

// ---------------------------------------------------------------------------
// Scrape run tracking
// ---------------------------------------------------------------------------

export interface ScrapeRun {
  id: string;
  source: string;
  startedAt: Date;
  completedAt: Date | null;
  status: 'running' | 'completed' | 'failed';
  jobsFound: number;
  jobsNew: number;
  jobsDuplicate: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Engine events
// ---------------------------------------------------------------------------

export type EngineEventType =
  | 'scrape:started'
  | 'scrape:progress'
  | 'scrape:completed'
  | 'scrape:failed'
  | 'job:new'
  | 'job:duplicate'
  | 'health:update'
  | 'log';

export interface EngineEvent {
  type: EngineEventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HTTP / Transport
// ---------------------------------------------------------------------------

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  followRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  responseTimeMs: number;
}

export interface ProxyConfig {
  url: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  health: number;      // 0-1
  totalRequests: number;
  totalFailures: number;
}

export interface SessionIdentity {
  id: string;
  userAgent: string;
  headers: Record<string, string>;
  cookies: Map<string, string>;
  proxy: ProxyConfig | null;
  requestCount: number;
  createdAt: Date;
  lastUsedAt: Date;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  env: string;
  scrapeIntervalMinutes: number;
  scrapeJitterMinutes: number;
  maxConcurrentScrapes: number;
  rateLimitRequestsPerMinute: number;
  rateLimitBurst: number;
  proxyUrls: string[];
  enableRemoteOk: boolean;
  enableHackerNews: boolean;
  dbPath: string;
  logLevel: string;
}
