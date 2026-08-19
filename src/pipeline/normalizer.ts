// ---------------------------------------------------------------------------
// Data normalizer — transforms raw adapter output into canonical JobListing
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';
import he from 'he';
import type { RawJobListing, JobListing, SalaryRange } from '../types.js';

/** Normalize a raw listing into the canonical schema */
export function normalize(raw: RawJobListing): JobListing {
  const now = new Date();

  return {
    id: generateId(raw.source, raw.externalId),
    source: raw.source,
    externalId: raw.externalId,
    title: cleanText(raw.title || 'Untitled'),
    company: cleanText(raw.company || 'Unknown'),
    location: normalizeLocation(raw.location || ''),
    description: cleanText(raw.description || ''),
    salary: parseSalary(raw.salaryText),
    tags: normalizeTags(raw.tags || []),
    url: raw.url || '',
    postedAt: parseDate(raw.postedAt) || now,
    scrapedAt: now,
    confidence: calculateConfidence(raw),
  };
}

/** Generate a deterministic ID from source + external ID */
function generateId(source: string, externalId: string): string {
  return createHash('sha256')
    .update(`${source}:${externalId}`)
    .digest('hex')
    .slice(0, 16);
}

/** Clean text: trim, collapse whitespace, decode entities */
function cleanText(text: string): string {
  if (!text) return '';
  try {
    let cleaned = text;
    let prev = '';
    
    // Some APIs double-encode (e.g., &amp;#x2F;), decode until stable
    let attempts = 0;
    while (cleaned !== prev && attempts < 5) {
      prev = cleaned;
      cleaned = he.decode(cleaned);
      attempts++;
    }

    // Fix common mojibake (utf-8 read as latin1) if it appears
    try {
      if (/[ÃÂ]/.test(cleaned)) { // fast check for common mojibake chars
        const fixed = decodeURIComponent(escape(cleaned));
        if (fixed) cleaned = fixed;
      }
    } catch {
      // ignore if it's not actually mojibake
    }
    
    return cleaned.replace(/\s+/g, ' ').trim();
  } catch {
    return text.replace(/\s+/g, ' ').trim();
  }
}

/** Normalize location strings */
function normalizeLocation(location: string): string {
  const cleaned = cleanText(location);
  if (!cleaned) return 'Not specified';

  const lower = cleaned.toLowerCase();

  // Normalize common remote variants
  if (lower === 'remote' || lower === 'worldwide' || lower === 'anywhere') {
    return 'Remote';
  }
  if (lower.includes('remote') && lower.includes('/')) {
    return cleaned; // "Remote / San Francisco" — keep as-is
  }

  return cleaned;
}

/** Parse salary text into structured SalaryRange */
function parseSalary(text?: string): SalaryRange | null {
  if (!text) return null;

  // Match patterns like "$120k-$180k", "$120,000 - $180,000", "120000-180000"
  const rangeMatch = text.match(
    /\$?([\d,]+\.?\d*)\s*[kK]?\s*[-–—to]+\s*\$?([\d,]+\.?\d*)\s*[kK]?/
  );

  if (rangeMatch) {
    let min = parseFloat(rangeMatch[1].replace(/,/g, ''));
    let max = parseFloat(rangeMatch[2].replace(/,/g, ''));

    // Handle "k" suffix
    if (text.toLowerCase().includes('k') || min < 1000) {
      if (min < 1000) min *= 1000;
      if (max < 1000) max *= 1000;
    }

    // Detect currency
    const currency = text.includes('€') ? 'EUR'
      : text.includes('£') ? 'GBP'
      : 'USD';

    return { min, max, currency };
  }

  // Single value: "$150k", "$150,000"
  const singleMatch = text.match(/\$?([\d,]+\.?\d*)\s*[kK]?/);
  if (singleMatch) {
    let value = parseFloat(singleMatch[1].replace(/,/g, ''));
    if (value < 1000) value *= 1000;

    return { min: value, max: value, currency: 'USD' };
  }

  return null;
}

/** Normalize tags: lowercase, dedupe, sort */
function normalizeTags(tags: string[]): string[] {
  const normalized = tags
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());

  return [...new Set(normalized)].sort();
}

/** Parse various date formats into Date */
function parseDate(input?: string | number): Date | null {
  if (!input) return null;

  if (typeof input === 'number') {
    // Unix timestamp (seconds or milliseconds)
    const ts = input < 1e12 ? input * 1000 : input;
    return new Date(ts);
  }

  const parsed = new Date(input);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** Calculate extraction confidence (0-1) based on field completeness */
function calculateConfidence(raw: RawJobListing): number {
  let score = 0;
  let maxScore = 0;

  const fields: [unknown, number][] = [
    [raw.title, 3],        // title is critical
    [raw.company, 3],      // company is critical
    [raw.description, 2],  // description matters
    [raw.location, 1],
    [raw.url, 1],
    [raw.postedAt, 1],
    [raw.tags?.length, 0.5],
    [raw.salaryText, 0.5],
  ];

  for (const [value, weight] of fields) {
    maxScore += weight;
    if (value && String(value).trim().length > 0) {
      score += weight;
    }
  }

  return Math.round((score / maxScore) * 100) / 100;
}
