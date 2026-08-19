// ---------------------------------------------------------------------------
// WebSocket manager for real-time dashboard updates
// ---------------------------------------------------------------------------

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { EngineEvent } from '../types.js';

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });

      // Send a welcome message
      this.send(ws, {
        type: 'connected',
        timestamp: new Date().toISOString(),
        data: { clientCount: this.clients.size },
      });
    });
  }

  /** Broadcast an engine event to all connected clients */
  broadcast(event: EngineEvent): void {
    const payload = JSON.stringify({
      type: event.type,
      timestamp: event.timestamp.toISOString(),
      data: event.data,
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Send a message to a specific client */
  private send(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /** Get the number of connected clients */
  get clientCount(): number {
    return this.clients.size;
  }
}
