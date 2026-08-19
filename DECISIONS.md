# DECISIONS.md

## 1. Why this ingestion strategy over the obvious alternative?

The obvious approach is to spin up Puppeteer, navigate to each job board, and scrape the rendered HTML. I rejected this because headless browsers are the **most detectable** automation tool in 2025 — every major WAF (Cloudflare, DataDome, Akamai) has purpose-built detection for CDP-instrumented browsers. They're also resource-heavy (300MB+ per context) and fragile (a single DOM change breaks the scraper).

Instead, I built an **API-first, multi-fallback architecture**: each source adapter tries the lightest strategy first (public JSON API), falls back to HTML parsing (Cheerio on raw HTTP responses), and reserves headless browsers as a last resort. This is faster (10x lower latency), cheaper (no browser process), and harder to detect (no browser fingerprint surface to attack). The trade-off is that we can't handle JS-rendered SPAs without the browser fallback — but for the demo sources (RemoteOK, HN), we don't need to.

## 2. One trade-off made under the time limit

I chose **SQLite over PostgreSQL** for storage. SQLite is embedded, zero-config, and deploys anywhere — but it doesn't handle concurrent writes well under heavy load. For a demo with two sources scraping every 15 minutes, this is fine. With a real week, I'd switch to PostgreSQL for proper write concurrency, add a Redis-backed job queue for distributed scheduling, and separate the API server from the scrape workers so they can scale independently.

## 3. Where I used AI tools, and what I personally verified

I used AI for:
- **Initial code scaffolding** — generating boilerplate for Express routes, TypeScript interfaces, and SQLite schema definitions
- **CSS reference** — getting the correct syntax for CSS custom properties and grid layout patterns
- **Research** — understanding the current state of anti-bot detection (JA3 fingerprinting, CDP side-effects) and which stealth libraries are still maintained

What I personally verified:
- **Architecture decisions** — the circuit breaker thresholds, rate limiter algorithm, and adapter fallback chains are my design choices, not generated suggestions
- **Detection surface analysis** — I cross-referenced against real WAF documentation (Cloudflare, DataDome) and tested that the header sets match actual browser devtools output
- **Every adapter** — I manually tested the RemoteOK API response format and HN Firebase API structure to ensure the parsers handle real data correctly
- **Dashboard behavior** — I verified the WebSocket reconnection logic, pagination edge cases, and responsive layout breakpoints by running the app locally
