# Ingestion Engine

Production-grade job listing ingestion engine with multi-layer anti-detection architecture, adaptive rate limiting, circuit breakers, and a real-time monitoring dashboard.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

## Architecture

- **Orchestrator** — coordinates scrape lifecycle, rate limiters, circuit breakers
- **Source Adapters** — pluggable data sources (RemoteOK, HackerNews)
- **Transport Layer** — hardened HTTP client with fingerprint coherence
- **Data Pipeline** — normalize → deduplicate → validate → store
- **Storage** — SQLite with WAL mode, zero-config
- **Dashboard** — real-time monitoring via WebSocket

## API

| Endpoint | Method | Description |
|:---|:---|:---|
| `/api/jobs` | GET | Paginated job listings (filters: `source`, `search`) |
| `/api/jobs/:id` | GET | Single job detail |
| `/api/health` | GET | System health status |
| `/api/runs` | GET | Scrape run history |
| `/api/stats` | GET | Pipeline statistics |
| `/api/scrape` | POST | Trigger manual scrape |
| `/ws` | WS | Real-time event stream |

## Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `R` | Trigger scrape |
| `F` | Focus search |
| `Esc` | Clear search focus |

## Deployment

### Render (recommended)
Push to GitHub, connect to Render, it auto-deploys from `render.yaml`.

### Docker
```bash
docker build -t ingestion-engine .
docker run -p 3000:3000 ingestion-engine
```

## Documentation

- [DESIGN.md](./DESIGN.md) — System architecture, detection surface analysis, resilience patterns
- [DECISIONS.md](./DECISIONS.md) — Strategy rationale, trade-offs, AI tool usage
