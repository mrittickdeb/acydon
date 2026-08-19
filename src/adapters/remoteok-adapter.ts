// ---------------------------------------------------------------------------
// RemoteOK source adapter
// ---------------------------------------------------------------------------
// Dual-mode ingestion: primary path uses the public JSON API, fallback
// scrapes HTML with Cheerio. Implements the SourceAdapter interface.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import type { SourceAdapter, RawJobListing, DetectionProfile } from '../types.js';
import { getHttpClient } from '../transport/http-client.js';

const API_URL = 'https://remoteok.com/api';
const HTML_URL = 'https://remoteok.com';

export class RemoteOkAdapter implements SourceAdapter {
  readonly name = 'remoteok';

  async *scrape(): AsyncGenerator<RawJobListing> {
    const client = getHttpClient();

    // Strategy 1: Try the JSON API first (faster, more reliable)
    try {
      const response = await client.request({
        url: API_URL,
        headers: {
          'Accept': 'application/json',
        },
        timeout: 20_000,
      });

      if (response.status === 200 && response.body.trim().startsWith('[')) {
        const data = JSON.parse(response.body);

        // RemoteOK API returns an array; first element is metadata, rest are jobs
        for (let i = 1; i < data.length; i++) {
          const item = data[i];
          if (!item.id) continue;

          yield {
            source: this.name,
            externalId: String(item.id),
            title: item.position || item.title || '',
            company: item.company || '',
            location: item.location || 'Remote',
            description: this.cleanHtml(item.description || ''),
            salaryText: this.extractSalary(item),
            tags: Array.isArray(item.tags) ? item.tags : [],
            url: item.url ? `https://remoteok.com${item.url}` : `https://remoteok.com/remote-jobs/${item.id}`,
            postedAt: item.date || item.epoch ? new Date(item.epoch ? item.epoch * 1000 : item.date).toISOString() : undefined,
            raw: item,
          };
        }
        return;
      }
    } catch (err) {
      // API failed — fall through to HTML scraping
    }

    // Strategy 2: HTML fallback with Cheerio
    try {
      const response = await client.request({
        url: HTML_URL,
        timeout: 25_000,
      });

      if (response.status !== 200) {
        throw new Error(`RemoteOK HTML returned status ${response.status}`);
      }

      const $ = cheerio.load(response.body);

      // RemoteOK uses table rows with class "job" for each listing
      const rows = $('tr.job').toArray();

      for (const row of rows) {
        const $row = $(row);
        const id = $row.attr('data-id') || $row.attr('id') || '';
        if (!id) continue;

        const title = $row.find('h2[itemprop="title"]').text().trim()
          || $row.find('.company_and_position h2').text().trim()
          || $row.find('td.company_and_position h2').text().trim();

        const company = $row.find('h3[itemprop="name"]').text().trim()
          || $row.find('.companyLink h3').text().trim()
          || $row.find('td.company_and_position h3').text().trim();

        const location = $row.find('.location').text().trim() || 'Remote';

        const tags: string[] = [];
        $row.find('.tag h3').each((_, el) => {
          const tag = $(el).text().trim();
          if (tag) tags.push(tag);
        });

        const linkEl = $row.find('a.preventLink');
        const href = linkEl.attr('href') || '';
        const url = href ? `https://remoteok.com${href}` : '';

        const dateAttr = $row.find('time').attr('datetime') || '';

        yield {
          source: this.name,
          externalId: id.replace('job-', ''),
          title,
          company,
          location,
          description: '',
          tags,
          url,
          postedAt: dateAttr || undefined,
        };
      }
    } catch (err) {
      throw new Error(`RemoteOK scrape failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = getHttpClient();
      const response = await client.request({
        url: API_URL,
        timeout: 10_000,
        headers: { 'Accept': 'application/json' },
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  getDetectionProfile(): DetectionProfile {
    return {
      source: this.name,
      risks: [
        'Rate limiting on API endpoint (429 after ~60 req/min)',
        'Cloudflare protection on HTML pages',
        'User-Agent filtering',
      ],
      mitigations: [
        'API-first approach avoids browser fingerprinting entirely',
        'Realistic headers with coherent browser profiles',
        'Adaptive rate limiting with exponential backoff',
        'HTML fallback if API starts blocking',
      ],
      requiresBrowser: false,
      hasPublicApi: true,
      rateLimitPerMinute: 30,
    };
  }

  /** Strip HTML tags from description text */
  private cleanHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Extract salary info from RemoteOK's various salary fields */
  private extractSalary(item: Record<string, unknown>): string | undefined {
    if (item.salary_min && item.salary_max) {
      return `$${item.salary_min}-$${item.salary_max}`;
    }
    if (item.salary) {
      return String(item.salary);
    }
    return undefined;
  }
}
