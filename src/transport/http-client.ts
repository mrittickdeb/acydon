// ---------------------------------------------------------------------------
// Hardened HTTP client with fingerprint coherence
// ---------------------------------------------------------------------------
// Wraps Node's undici with realistic header sets, user-agent rotation, and
// consistent identity profiles to avoid detection through incoherent signals.
// ---------------------------------------------------------------------------

import type { HttpRequestOptions, HttpResponse } from '../types.js';

// ---- Realistic browser profiles ----
// Each profile is a coherent set: UA + headers must tell the same story.

interface BrowserProfile {
  userAgent: string;
  platform: string;
  acceptLanguage: string;
  secChUa: string;
  secChUaPlatform: string;
  secChUaMobile: string;
}

const PROFILES: BrowserProfile[] = [
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: 'Windows',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: 'macOS',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    secChUaPlatform: '"macOS"',
    secChUaMobile: '?0',
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    platform: 'Windows',
    acceptLanguage: 'en-US,en;q=0.5',
    secChUa: '',
    secChUaPlatform: '',
    secChUaMobile: '',
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'macOS',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '',
    secChUaPlatform: '',
    secChUaMobile: '',
  },
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: 'Linux',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    secChUaPlatform: '"Linux"',
    secChUaMobile: '?0',
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
    platform: 'macOS',
    acceptLanguage: 'en-US,en;q=0.5',
    secChUa: '',
    secChUaPlatform: '',
    secChUaMobile: '',
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    platform: 'Windows',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Microsoft Edge";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
  },
];

// Weighted selection: Chrome/Edge on Windows/Mac are most common
const PROFILE_WEIGHTS = [30, 25, 12, 10, 8, 7, 8]; // must sum roughly to 100

export class HttpClient {
  private currentProfile: BrowserProfile;
  private requestCount = 0;
  private rotateEvery: number;

  constructor(rotateEvery = 50) {
    this.rotateEvery = rotateEvery;
    this.currentProfile = this.selectProfile();
  }

  /** Make an HTTP request with realistic headers */
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    // Rotate profile periodically
    this.requestCount++;
    if (this.requestCount % this.rotateEvery === 0) {
      this.currentProfile = this.selectProfile();
    }

    const headers = this.buildHeaders(options.headers);
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = options.timeout ?? 30_000;
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(options.url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
        redirect: options.followRedirects === false ? 'manual' : 'follow',
      });

      clearTimeout(timer);

      const body = await response.text();
      const responseTimeMs = Date.now() - startTime;

      // Convert headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        headers: responseHeaders,
        body,
        responseTimeMs,
      };
    } catch (err: unknown) {
      const responseTimeMs = Date.now() - startTime;
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { status: 0, headers: {}, body: '', responseTimeMs };
      }
      throw err;
    }
  }

  /** Build coherent headers from the current browser profile */
  private buildHeaders(custom?: Record<string, string>): Record<string, string> {
    const p = this.currentProfile;
    const isChrome = p.userAgent.includes('Chrome') && !p.userAgent.includes('Edg');
    const isFirefox = p.userAgent.includes('Firefox');

    const headers: Record<string, string> = {
      'User-Agent': p.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': p.acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };

    // Chrome/Edge-specific client hints
    if (p.secChUa) {
      headers['Sec-Ch-Ua'] = p.secChUa;
      headers['Sec-Ch-Ua-Mobile'] = p.secChUaMobile;
      headers['Sec-Ch-Ua-Platform'] = p.secChUaPlatform;
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'none';
      headers['Sec-Fetch-User'] = '?1';
    }

    // Firefox-specific
    if (isFirefox) {
      headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
      headers['DNT'] = '1';
    }

    // Override with any custom headers (e.g., for API endpoints)
    if (custom) {
      Object.assign(headers, custom);
    }

    return headers;
  }

  /** Select a profile using weighted random selection */
  private selectProfile(): BrowserProfile {
    const totalWeight = PROFILE_WEIGHTS.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < PROFILES.length; i++) {
      random -= PROFILE_WEIGHTS[i];
      if (random <= 0) return PROFILES[i];
    }

    return PROFILES[0];
  }

  /** Get the current browser profile (for session coherence) */
  getCurrentProfile(): BrowserProfile {
    return { ...this.currentProfile };
  }

  /** Force a specific profile (for session pinning) */
  setProfile(profile: BrowserProfile): void {
    this.currentProfile = profile;
  }
}

/** Singleton-ish client for the application */
let _client: HttpClient | null = null;

export function getHttpClient(): HttpClient {
  if (!_client) _client = new HttpClient();
  return _client;
}
