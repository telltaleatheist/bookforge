import { inject, Injectable } from '@angular/core';
import { ApiService } from './api.service';

/**
 * Durable, offline-tolerant queue for listening-analytics events. Every heartbeat
 * is persisted BEFORE it's sent, so a flaky/offline connection never loses
 * listening time — the flusher drains the queue on reconnect (the `online` event
 * + a periodic tick). Each event carries a stable `id`, and the server's
 * `/api/analytics/heartbeat` is idempotent (append-if-absent, slice 3), so a
 * replay after an ambiguous failure can't double-count.
 *
 * Events are routed to the book's ORIGIN server with that server's reader token,
 * both captured at enqueue time (the reader who listened owns the event even if
 * the active profile later changes). On-device `local` books have no token and
 * never reach here.
 */

const QUEUE_KEY = 'bookshelf-analytics-queue';
const FLUSH_INTERVAL_MS = 30_000;

interface QueuedEvent {
  serverId: string;   // '' = the origin/same-origin server
  token: string;      // reader token for that server, captured at enqueue
  payload: { bookPath: string; title: string; author: string; seconds: number; id: string };
}

@Injectable({ providedIn: 'root' })
export class AnalyticsQueueService {
  private readonly api = inject(ApiService);

  private queue: QueuedEvent[] = this.load();
  private flushing = false;

  constructor() {
    // Drain on reconnect and on a slow timer; also attempt once at startup for
    // anything left from a previous session.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.flush());
      setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
    void this.flush();
  }

  /** How many events are still waiting to be sent (for a UI hint if wanted). */
  get pending(): number { return this.queue.length; }

  /** Persist an event, then try to send it right away. */
  enqueue(serverId: string | undefined, token: string, payload: QueuedEvent['payload']): void {
    this.queue.push({ serverId: serverId ?? '', token, payload });
    this.save();
    void this.flush();
  }

  /** Send queued events oldest-first; stop at the first failure (network down)
   *  and keep the rest for the next attempt. Idempotent server-side by event id. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const ev = this.queue[0];
        const ok = await this.send(ev);
        if (!ok) break;          // transient — retry the whole tail later
        this.queue.shift();      // delivered (or idempotently duplicate) — drop it
        this.save();
      }
    } finally {
      this.flushing = false;
    }
  }

  /** One POST via the shared API surface. Returns true when delivered or
   *  terminally accepted (drop it), false when worth retrying (keep it). */
  private send(ev: QueuedEvent): Promise<boolean> {
    return this.api.postHeartbeat(ev.token, ev.payload, ev.serverId);
  }

  private load(): QueuedEvent[] {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  private save(): void {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
  }
}
