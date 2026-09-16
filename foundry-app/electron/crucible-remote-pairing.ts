import { randomUUID } from 'node:crypto';
import type { startPairing, pollPairing, Pairing } from '@crucible/client';
import type { RemotePairingProgress } from '../shared/remote-pairing';

type Request = Awaited<ReturnType<typeof startPairing>>;
interface Session {
  owner: number;
  request: Request;
  view: RemotePairingProgress;
  approved?: Pairing;
  polling?: Promise<RemotePairingProgress>;
}

/** One pending request per window. Main alone holds the exchange credentials. */
export class RemotePairingSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<number, symbol>();

  constructor(
    private readonly connect: (pairing: Pairing) => Promise<void>,
    private readonly beginRequest: typeof startPairing,
    private readonly pollRequest: typeof pollPairing,
    private readonly now = Date.now,
  ) {}

  cancelOwner(owner: number): void {
    this.requests.delete(owner);
    for (const [id, session] of this.sessions) {
      if (session.owner === owner) this.sessions.delete(id);
    }
  }

  async begin(owner: number, address: string): Promise<RemotePairingProgress> {
    this.cancelOwner(owner);
    const generation = Symbol();
    this.requests.set(owner, generation);
    for (const [id, session] of this.sessions) {
      if (session.view.expiresAt <= this.now()) this.sessions.delete(id);
    }
    const request = await this.beginRequest(address, 'Foundry');
    if (this.requests.get(owner) !== generation) throw new Error('Pairing was cancelled.');
    const id = randomUUID();
    const view: RemotePairingProgress = {
      id, name: request.name, url: request.url, userCode: request.userCode,
      expiresAt: this.now() + request.expiresIn * 1000,
      pollAfterMs: Math.max(1000, request.interval * 1000), status: 'pending',
    };
    this.sessions.set(id, { owner, request, view });
    return { ...view };
  }

  async poll(owner: number, id: string): Promise<RemotePairingProgress> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('This pairing request is no longer available. Connect again.');
    if (session.polling) return session.polling;
    session.polling = this.advance(id, session);
    try { return await session.polling; }
    finally { delete session.polling; }
  }

  private async advance(id: string, session: Session): Promise<RemotePairingProgress> {
    if (session.view.expiresAt <= this.now()) {
      this.sessions.delete(id);
      this.requests.delete(session.owner);
      return { ...session.view, status: 'expired' };
    }
    const result = session.approved
      ? { status: 'approved' as const, pairing: session.approved }
      : await this.pollRequest(session.request);
    // A window closed or started another request while the HTTP call ran.
    if (this.sessions.get(id) !== session) throw new Error('Pairing was cancelled.');
    if (result.status === 'approved') {
      if (!result.pairing) throw new Error('Crucible approved pairing without publishing a connection.');
      session.approved = result.pairing;
      await this.connect(result.pairing);
    }
    if (result.status !== 'pending') {
      this.sessions.delete(id);
      this.requests.delete(session.owner);
    }
    return { ...session.view, status: result.status };
  }
}
