# Ingestion Engine — System Design Document

## Architecture Overview

```
  ┌────────────────────────────────────────────────────────────────┐
  │                    REAL-TIME DASHBOARD                         │
  │  WebSocket ← Live events ← Orchestrator event bus             │
  └──────────────────────┬───────────────────────────────────────┘
                         │
  ┌──────────────────────┴───────────────────────────────────────┐
  │                      API SERVER (Express)                     │
  │  GET /api/jobs · GET /api/health · POST /api/scrape           │
  └──────────────────────┬───────────────────────────────────────┘
                         │
  ┌──────────────────────┴───────────────────────────────────────┐
  │                      ORCHESTRATOR                             │
  │                                                               │
  │  Scheduler ──→ Source Adapters ──→ Data Pipeline ──→ Storage  │
  │     │              │                    │               │     │
  │     │         Rate Limiter         Normalizer       SQLite    │
  │     │         Health Monitor       Deduplicator    (WAL)     │
  │     │         Circuit Breaker      Validator                  │
  │     │              │                                          │
  │     │         Transport Layer                                 │
  │     │         ├── HTTP Client (fingerprint coherence)         │
  │     │         ├── Proxy Manager (health-weighted)             │
  │     │         └── Session Pool (identity persistence)         │
  └──────────────────────────────────────────────────────────────┘
```

---

## 1. Detection Surface — What Gives a Bot Away

Modern anti-bot systems analyze traffic across four distinct layers simultaneously. Failing any single layer triggers detection.

### 1.1 Network Layer (IP Reputation)

| Signal | What gets flagged | Our mitigation |
|:---|:---|:---|
| Datacenter IPs | AWS, GCP, Azure, Hetzner ranges are pre-flagged in most WAFs | Architecture supports residential proxy rotation; demo runs proxy-less against permissive sources |
| IP velocity | Same IP hitting dozens of pages per minute | Adaptive rate limiter with token bucket algorithm; backs off on 429/403 |
| Subnet clustering | Multiple requests from the same /24 block | Proxy manager tracks subnet diversity across pools |
| Geographic mismatch | IP in Brazil, Accept-Language is `en-US`, timezone is UTC | Session pool ensures geographic coherence with language/timezone |

### 1.2 TLS/HTTP Fingerprinting

| Signal | What gets flagged | Our mitigation |
|:---|:---|:---|
| TLS fingerprint (JA3/JA4) | Node's `http` module has a distinct, non-browser JA3 hash | Using Node's built-in `fetch` (undici) which has a more neutral fingerprint; architecture supports `curl_cffi` drop-in for hardened TLS |
| HTTP/2 header ordering | Automation tools send headers in different order than browsers | Headers are constructed to match real browser ordering per profile |
| Missing headers | Bots often omit `Sec-Fetch-*`, `Accept-Encoding`, or send empty `Accept` | Full header set generated per browser profile, including Chrome-specific client hints |

### 1.3 Browser Fingerprinting

| Signal | What gets flagged | Our mitigation |
|:---|:---|:---|
| `navigator.webdriver` | Set to `true` in Puppeteer/Playwright by default | API-first strategy avoids browser entirely; browser engine (reserved for fallback) patches this |
| Canvas/WebGL fingerprint | Headless browsers produce unrealistic GPU renders | Not applicable — we don't use a browser for our demo sources |
| CDP side-effects | Chrome DevTools Protocol instrumentation leaves detectable artifacts | API-first approach sidesteps this entirely |
| Missing browser APIs | Headless mode lacks `Notification`, `Bluetooth`, etc. | Not applicable for API-first sources |

### 1.4 Behavioral Analysis

| Signal | What gets flagged | Our mitigation |
|:---|:---|:---|
| Metronomic timing | Requests at exactly 1.000s intervals | Scheduler uses ±3 minute jitter; inter-request delays randomized (100-300ms) |
| No session warmup | First request goes directly to data endpoint | Session pool supports warming (hit homepage first) |
| Cookie-less requests | Real browsers always send cookies after first visit | Session pool maintains cookies across requests per source |
| Unrealistic volume | Scraping 10,000 pages per hour from a single source | Rate limiter caps at 20-30 req/min, auto-reduces on resistance |

---

## 2. Ingestion Strategy

### 2.1 Multi-Strategy Approach (API-First)

The core principle: **never use a heavier tool than necessary.**

```
Priority 1: Public API (JSON)    → Fastest, most reliable, lowest detection risk
Priority 2: HTML Scraping        → Fallback when API fails or changes
Priority 3: Headless Browser     → Last resort, for JS-rendered content only
```

Each source adapter implements this fallback chain internally. The orchestrator doesn't know or care which strategy the adapter chose — it just receives normalized `RawJobListing` objects.

### 2.2 Source Adapters

**RemoteOK:**
- Primary: Public JSON API at `/api` — structured, fast, no auth needed
- Fallback: HTML scraping with Cheerio using multiple CSS selector strategies
- Risk level: Low (public API, permissive ToS)

**Hacker News:**
- Primary: Firebase-hosted API — fetch job story IDs, then individual items
- Secondary: "Who's Hiring" thread comments parsed with heuristic text extraction
- Risk level: Very low (public API, no anti-bot measures)

### 2.3 For High-Protection Targets (LinkedIn, Indeed, Naukri)

The same architecture would extend with:
- **Residential proxy rotation** via Bright Data or Smartproxy (plugged into `ProxyManager`)
- **TLS fingerprint matching** via `curl_cffi` or `tls-client` (drop-in replacement for `HttpClient`)
- **Headless browser with stealth** via `nodriver` or `Camoufox` (activating `BrowserEngine`)
- **Session warming** with organic browsing patterns before targeting job search endpoints
- **CAPTCHA pipeline** with 2captcha/anti-captcha integration
- **Account rotation** for sources requiring login (managed pool of aged accounts)

### 2.4 Pacing & Rate Limiting

The adaptive rate limiter uses a **token bucket algorithm** per source:

```
Normal state:  20 req/min, burst of 5
On 429/403:    Rate halved (exponential backoff, floor at 10% of base)
On sustained success (10 consecutive): Rate increases by 20%, capped at base
```

This prevents the "death spiral" where aggressive retry logic causes more blocks, which causes more retries.

### 2.5 Session Management

Each scrape session maintains a **coherent identity**:

```
Session = {
  Browser Profile:  Chrome 125 on Windows (UA + headers + client hints)
  Cookies:          Persistent for session duration
  Proxy:            Pinned to one IP for session coherence
  Lifetime:         Max 100 requests or 30 minutes, whichever comes first
}
```

Session rotation happens **between** scrape runs, not **during** them. Mid-scrape identity switches are a common detection signal.

---

## 3. Resilience

### 3.1 Circuit Breaker Pattern

Per-source circuit breaker prevents hammering dead or hostile sources:

```
CLOSED ──(3 consecutive failures)──→ OPEN ──(30s backoff)──→ HALF_OPEN
   ↑                                                              │
   └────────────(successful probe)────────────────────────────────┘
                                                                   │
   OPEN ←────────────(failed probe, 2x backoff)───────────────────┘
```

Backoff is exponential: 30s → 60s → 120s → 240s → 300s (capped at 5 minutes).

### 3.2 Multi-Strategy Parsing

Each adapter uses multiple extraction strategies per field:

```
Title extraction:
  1. CSS selector:  h2[itemprop="title"]
  2. CSS fallback:  .company_and_position h2
  3. Generic:       td.company_and_position h2
  4. Regex:         First <h2> in the row
```

If the source changes its markup overnight, we don't silently fail — we try alternates and log which strategy succeeded, making it easy to update selectors.

### 3.3 Data Quality Gate

Every listing passes through validation before storage:
- **Reject**: Missing title or company (critical fields)
- **Reject**: Title is only numbers/whitespace (garbage data)
- **Warn**: Description < 10 characters
- **Warn**: Confidence score < 30%

Validation failures are logged but don't crash the pipeline. Other valid listings in the same scrape run continue processing.

### 3.4 Deduplication

Three-layer dedup prevents duplicate storage:
1. **Source + External ID**: Same listing re-scraped from the same source
2. **Content hash**: MD5 of normalized `title::company` — catches slight variations
3. **Fuzzy cross-source**: Same job posted on RemoteOK and HN

### 3.5 Silent Failure Prevention

Every scrape run is tracked in the `scrape_runs` table with:
- Start/end timestamps
- Job counts (found, new, duplicate)
- Error messages
- Status (running/completed/failed)

The dashboard shows this history prominently. If a source starts returning 0 jobs when it previously returned 50, the operator sees it immediately — not three weeks later when a stakeholder asks "why is the data stale?"

---

## 4. Where We'd Stop — Ethical Boundaries

### Technical Line

| ✅ We do | ❌ We don't |
|:---|:---|
| Hit public APIs and RSS feeds | Bypass CAPTCHAs on production sites |
| Scrape publicly visible job listings | Log in with fake/stolen accounts |
| Respect `robots.txt` directives | Scrape behind authentication walls |
| Rate limit to avoid server impact | Overwhelm servers with aggressive parallelism |
| Cache results to reduce redundant requests | Store personal data (emails, phone numbers) |

### Legal Line

- The demo targets sources with **public APIs** (RemoteOK, HN Firebase) — no ToS violation
- For production use against protected sites (LinkedIn, Indeed): consult legal counsel before deployment
- The architecture is designed to be **source-agnostic** — the ethical boundary is in the adapter configuration, not baked into the system

### Personal Line

> "Every platform here has terms of service against scraping. Where's your personal and technical line?"

My line: **public data accessed through public channels at a respectful pace is fair game.** The moment you need to break authentication, solve CAPTCHAs, or impersonate a real user's session, you've crossed from "reading a public bulletin board" to "trespassing." The architecture supports both sides of that line — the operator decides which adapters to activate.

---

## 5. What Would Change with a Real Week

1. **Redis-backed job queue** replacing the in-memory scheduler — enables horizontal scaling
2. **PostgreSQL** replacing SQLite — proper concurrent write handling at scale
3. **Source-specific adapters** for LinkedIn (via profile-based session management) and Indeed (via their partner API)
4. **Monitoring stack** (Prometheus metrics + Grafana dashboards) replacing the built-in health monitor
5. **Webhook notifications** when circuit breakers trip or data quality drops
6. **Content diffing** to detect when a source changes its markup structure
