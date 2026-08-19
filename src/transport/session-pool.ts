// ---------------------------------------------------------------------------
// Session identity pool
// ---------------------------------------------------------------------------
// Each session is a coherent identity: a pinned browser profile, cookies,
// and optionally a proxy. Sessions rotate after a configurable number of
// requests or time window, and new sessions are "warmed" with an initial
// benign request before targeting data endpoints.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import type { SessionIdentity } from '../types.js';
import { HttpClient } from './http-client.js';

export class SessionPool {
  private sessions = new Map<string, SessionIdentity>();
  private maxRequestsPerSession: number;
  private maxSessionAgeMs: number;

  constructor(maxRequests = 100, maxAgeMinutes = 30) {
    this.maxRequestsPerSession = maxRequests;
    this.maxSessionAgeMs = maxAgeMinutes * 60 * 1000;
  }

  /** Get or create a session for a source */
  getSession(source: string): SessionIdentity {
    let session = this.sessions.get(source);

    // Check if session needs rotation
    if (session && this.shouldRotate(session)) {
      this.sessions.delete(source);
      session = undefined;
    }

    if (!session) {
      session = this.createSession();
      this.sessions.set(source, session);
    }

    session.requestCount++;
    session.lastUsedAt = new Date();
    return session;
  }

  /** Force-rotate a session for a source */
  rotateSession(source: string): SessionIdentity {
    this.sessions.delete(source);
    return this.getSession(source);
  }

  /** Get all active sessions */
  getActiveSessions(): { source: string; session: SessionIdentity }[] {
    const result: { source: string; session: SessionIdentity }[] = [];
    for (const [source, session] of this.sessions) {
      result.push({ source, session });
    }
    return result;
  }

  /** Check if a session should be rotated */
  private shouldRotate(session: SessionIdentity): boolean {
    const now = Date.now();
    const age = now - session.createdAt.getTime();

    return (
      session.requestCount >= this.maxRequestsPerSession ||
      age >= this.maxSessionAgeMs
    );
  }

  /** Create a fresh session with a coherent identity */
  private createSession(): SessionIdentity {
    const client = new HttpClient();
    const profile = client.getCurrentProfile();

    return {
      id: uuidv4(),
      userAgent: profile.userAgent,
      headers: {
        'Accept-Language': profile.acceptLanguage,
        ...(profile.secChUa ? {
          'Sec-Ch-Ua': profile.secChUa,
          'Sec-Ch-Ua-Platform': profile.secChUaPlatform,
          'Sec-Ch-Ua-Mobile': profile.secChUaMobile,
        } : {}),
      },
      cookies: new Map(),
      proxy: null,
      requestCount: 0,
      createdAt: new Date(),
      lastUsedAt: new Date(),
    };
  }
}
