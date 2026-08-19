// ---------------------------------------------------------------------------
// Slot-based proxy manager
// ---------------------------------------------------------------------------
// Manages a pool of proxy configurations with weighted selection based on
// health scores. Designed to work with residential proxy providers but
// gracefully falls back to direct connections when no proxies are configured.
// ---------------------------------------------------------------------------

import type { ProxyConfig } from '../types.js';

export class ProxyManager {
  private proxies: ProxyConfig[] = [];
  private directFallback = true;

  constructor(proxyUrls: string[]) {
    this.proxies = proxyUrls.map(url => this.parseProxyUrl(url)).filter(Boolean) as ProxyConfig[];

    if (this.proxies.length === 0) {
      this.directFallback = true;
    }
  }

  /** Get the next proxy to use (weighted by health) */
  getProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) return null;

    // Weighted random selection based on health score
    const totalHealth = this.proxies.reduce((sum, p) => sum + p.health, 0);
    if (totalHealth === 0) return this.proxies[0]; // all dead, try first

    let random = Math.random() * totalHealth;
    for (const proxy of this.proxies) {
      random -= proxy.health;
      if (random <= 0) return proxy;
    }

    return this.proxies[0];
  }

  /** Record a successful request through a proxy */
  recordSuccess(proxy: ProxyConfig): void {
    proxy.totalRequests++;
    // Slowly recover health toward 1.0
    proxy.health = Math.min(1.0, proxy.health + 0.05);
  }

  /** Record a failed request through a proxy */
  recordFailure(proxy: ProxyConfig): void {
    proxy.totalRequests++;
    proxy.totalFailures++;
    // Reduce health on failure
    proxy.health = Math.max(0.01, proxy.health - 0.2);
  }

  /** Get all proxy statuses */
  getStatus(): { count: number; healthy: number; proxies: ProxyConfig[] } {
    const healthy = this.proxies.filter(p => p.health > 0.5).length;
    return {
      count: this.proxies.length,
      healthy,
      proxies: this.proxies.map(p => ({
        ...p,
        url: this.maskUrl(p.url), // don't expose credentials
      })),
    };
  }

  /** Whether we're using direct connections (no proxies) */
  get isDirect(): boolean {
    return this.proxies.length === 0;
  }

  /** Parse a proxy URL into a ProxyConfig */
  private parseProxyUrl(url: string): ProxyConfig | null {
    try {
      const parsed = new URL(url);
      return {
        url,
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port: parseInt(parsed.port, 10) || 80,
        username: parsed.username || undefined,
        password: parsed.password || undefined,
        health: 1.0,
        totalRequests: 0,
        totalFailures: 0,
      };
    } catch {
      return null;
    }
  }

  /** Mask credentials in URL for safe display */
  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.username) parsed.username = '***';
      if (parsed.password) parsed.password = '***';
      return parsed.toString();
    } catch {
      return '***';
    }
  }
}
