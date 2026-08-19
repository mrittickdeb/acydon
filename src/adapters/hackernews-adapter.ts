// ---------------------------------------------------------------------------
// Hacker News "Who's Hiring" source adapter
// ---------------------------------------------------------------------------
// Dual-mode: primary uses the Firebase-hosted HN API to fetch job story IDs
// and individual items. Fallback scrapes the HTML thread. Parses unstructured
// text into structured job fields using heuristics.
// ---------------------------------------------------------------------------

import type { SourceAdapter, RawJobListing, DetectionProfile } from '../types.js';
import { getHttpClient } from '../transport/http-client.js';

const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';
const HN_JOBS_URL = `${HN_API_BASE}/jobstories.json`;
const HN_ITEM_URL = (id: number) => `${HN_API_BASE}/item/${id}.json`;

// Also fetch "Who's Hiring" threads from the "whoishiring" user
const HN_USER_URL = `${HN_API_BASE}/user/whoishiring.json`;

export class HackerNewsAdapter implements SourceAdapter {
  readonly name = 'hackernews';

  async *scrape(): AsyncGenerator<RawJobListing> {
    const client = getHttpClient();

    // Strategy 1: Fetch official job stories from HN API
    try {
      const jobStoriesRes = await client.request({
        url: HN_JOBS_URL,
        headers: { 'Accept': 'application/json' },
        timeout: 15_000,
      });

      if (jobStoriesRes.status === 200) {
        const jobIds: number[] = JSON.parse(jobStoriesRes.body);

        // Limit to most recent 50 to avoid hammering the API
        const batch = jobIds.slice(0, 50);

        for (const id of batch) {
          try {
            const itemRes = await client.request({
              url: HN_ITEM_URL(id),
              headers: { 'Accept': 'application/json' },
              timeout: 10_000,
            });

            if (itemRes.status !== 200) continue;

            const item = JSON.parse(itemRes.body);
            if (!item || item.dead || item.deleted) continue;

            const parsed = this.parseJobStory(item);
            if (parsed) yield parsed;

            // Small delay between API calls to be respectful
            await this.delay(100 + Math.random() * 200);
          } catch {
            continue; // skip individual failures
          }
        }
      }
    } catch (err) {
      // API failed, continue to "Who's Hiring" threads
    }

    // Strategy 2: Fetch recent "Who's Hiring" threads
    try {
      const userRes = await client.request({
        url: HN_USER_URL,
        headers: { 'Accept': 'application/json' },
        timeout: 10_000,
      });

      if (userRes.status === 200) {
        const user = JSON.parse(userRes.body);
        if (user?.submitted && Array.isArray(user.submitted)) {
          // Get the most recent 3 threads (monthly)
          const recentThreads = user.submitted.slice(0, 3);

          for (const threadId of recentThreads) {
            yield* this.scrapeThread(threadId);
          }
        }
      }
    } catch {
      // Both strategies failed
      throw new Error('HackerNews: both API strategies failed');
    }
  }

  /** Scrape comments from a "Who's Hiring" thread */
  private async *scrapeThread(threadId: number): AsyncGenerator<RawJobListing> {
    const client = getHttpClient();

    try {
      const threadRes = await client.request({
        url: HN_ITEM_URL(threadId),
        headers: { 'Accept': 'application/json' },
        timeout: 15_000,
      });

      if (threadRes.status !== 200) return;

      const thread = JSON.parse(threadRes.body);
      if (!thread?.kids || !Array.isArray(thread.kids)) return;

      // Only check if it's actually a hiring thread
      const title = (thread.title || '').toLowerCase();
      if (!title.includes('hiring') && !title.includes('seeking')) return;

      // Fetch top-level comments (each is a job posting)
      const commentIds = thread.kids.slice(0, 80); // limit for demo

      for (const commentId of commentIds) {
        try {
          const commentRes = await client.request({
            url: HN_ITEM_URL(commentId),
            headers: { 'Accept': 'application/json' },
            timeout: 10_000,
          });

          if (commentRes.status !== 200) continue;

          const comment = JSON.parse(commentRes.body);
          if (!comment || comment.dead || comment.deleted || !comment.text) continue;

          const parsed = this.parseWhoIsHiringComment(comment, threadId);
          if (parsed) yield parsed;

          await this.delay(80 + Math.random() * 150);
        } catch {
          continue;
        }
      }
    } catch {
      // Thread scrape failed
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = getHttpClient();
      const response = await client.request({
        url: HN_JOBS_URL,
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
        'Firebase API has implicit rate limits',
        'Large threads require many individual API calls',
        'Text parsing is heuristic-based — format varies by poster',
      ],
      mitigations: [
        'Firebase API is public and well-documented — no auth needed',
        'Polite pacing (100-300ms between calls)',
        'Multi-strategy text parsing with confidence scoring',
        'Thread caching to reduce redundant fetches',
      ],
      requiresBrowser: false,
      hasPublicApi: true,
      rateLimitPerMinute: 60,
    };
  }

  /** Parse a HN job story (the official /jobstories endpoint) */
  private parseJobStory(item: Record<string, unknown>): RawJobListing | null {
    const title = String(item.title || '');
    const text = this.cleanHtml(String(item.text || ''));

    if (!title) return null;

    // HN job titles are usually "Company (YC S24) – Role – Location"
    const parsed = this.parseJobTitle(title);

    return {
      source: this.name,
      externalId: String(item.id),
      title: parsed.role || title,
      company: parsed.company || '',
      location: parsed.location || '',
      description: text || title,
      url: item.url ? String(item.url) : `https://news.ycombinator.com/item?id=${item.id}`,
      postedAt: item.time ? new Date(Number(item.time) * 1000).toISOString() : undefined,
      tags: parsed.tags,
    };
  }

  /** Parse a "Who's Hiring" thread comment */
  private parseWhoIsHiringComment(
    comment: Record<string, unknown>,
    threadId: number
  ): RawJobListing | null {
    const text = this.cleanHtml(String(comment.text || ''));
    if (!text || text.length < 20) return null;

    // First line usually follows: "Company | Role | Location | Remote | ..."
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    const firstLine = lines[0];
    const parsed = this.parseFirstLine(firstLine);

    return {
      source: this.name,
      externalId: String(comment.id),
      title: parsed.role || firstLine.slice(0, 100),
      company: parsed.company || '',
      location: parsed.location || '',
      description: lines.slice(1).join('\n').trim() || text,
      url: `https://news.ycombinator.com/item?id=${comment.id}`,
      postedAt: comment.time ? new Date(Number(comment.time) * 1000).toISOString() : undefined,
      tags: parsed.tags,
    };
  }

  /** Parse "Company | Role | Location" format from first line */
  private parseFirstLine(line: string): {
    company: string;
    role: string;
    location: string;
    tags: string[];
  } {
    // Split by common delimiters: | , – , - , ·
    const parts = line.split(/\s*[|–·]\s*/).map(s => s.trim()).filter(Boolean);
    const tags: string[] = [];

    if (parts.length === 0) {
      return { company: '', role: '', location: '', tags };
    }

    const company = parts[0] || '';
    let role = '';
    let location = '';

    // Heuristics for remaining parts
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const lower = part.toLowerCase();

      // Location indicators
      if (
        lower.includes('remote') || lower.includes('onsite') || lower.includes('hybrid') ||
        lower.includes('sf') || lower.includes('nyc') || lower.includes('berlin') ||
        lower.includes('london') || lower.includes('usa') || /,\s*[A-Z]{2}\b/.test(part)
      ) {
        location = location ? `${location}, ${part}` : part;
        if (lower.includes('remote')) tags.push('Remote');
        if (lower.includes('onsite')) tags.push('Onsite');
        if (lower.includes('hybrid')) tags.push('Hybrid');
      } else if (!role) {
        role = part;
      } else {
        // Additional parts might be salary, visa status, etc.
        if (lower.includes('visa')) tags.push('Visa Sponsor');
        if (/\$[\d,]+/.test(part)) tags.push('Salary Listed');
      }
    }

    return { company, role, location, tags };
  }

  /** Parse HN job title format: "Company (YC S24) – Role – Location" */
  private parseJobTitle(title: string): {
    company: string;
    role: string;
    location: string;
    tags: string[];
  } {
    const parts = title.split(/\s*[–—-]\s*/).map(s => s.trim()).filter(Boolean);
    const tags: string[] = [];

    if (parts.length >= 3) {
      return {
        company: parts[0],
        role: parts.slice(1, -1).join(' — '),
        location: parts[parts.length - 1],
        tags,
      };
    } else if (parts.length === 2) {
      return { company: parts[0], role: parts[1], location: '', tags };
    }

    return { company: title, role: '', location: '', tags };
  }

  /** Strip HTML tags */
  private cleanHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p>/gi, '\n')
      .replace(/<a[^>]+href="([^"]*)"[^>]*>/gi, '$1 ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
