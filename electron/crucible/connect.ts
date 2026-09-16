import { randomUUID } from 'crypto';
import { startPairing, pollPairing, type Pairing, type PairingRequest } from '@crucible/client';
import type { CruciblePairingPrompt, CruciblePairingDecision } from '../../shared/crucible/connect-wire';
import { addServer } from './servers';

interface Pending {
  requestId: string;
  controller: AbortController;
  request?: PairingRequest;
  expiresAt?: number;
  polling?: Promise<CruciblePairingDecision>;
}
interface PairingDeps {
  start: typeof startPairing;
  poll: typeof pollPairing;
  add(pairing: Pairing): { name: string };
}

/** One request per window. Device codes and bearer tokens stay in main. */
export class CrucibleConnections {
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly deps: PairingDeps = { start: startPairing, poll: pollPairing, add: addServer }) {}

  cancel(owner: number): void {
    this.pending.get(owner)?.controller.abort();
    this.pending.delete(owner);
  }

  async start(owner: number, address: string): Promise<CruciblePairingPrompt> {
    this.cancel(owner);
    const pending: Pending = { requestId: randomUUID(), controller: new AbortController() };
    this.pending.set(owner, pending);
    try {
      const request = await this.deps.start(address, 'BookForge', { signal: pending.controller.signal });
      if (this.pending.get(owner) !== pending) throw new Error('The connection request was cancelled.');
      pending.request = request;
      pending.expiresAt = Date.now() + request.expiresIn * 1000;
      return { requestId: pending.requestId, name: request.name, url: request.url,
        userCode: request.userCode, expiresIn: request.expiresIn, interval: request.interval };
    } catch (error) {
      if (this.pending.get(owner) === pending) this.cancel(owner);
      throw error;
    }
  }

  async poll(owner: number, requestId: string): Promise<CruciblePairingDecision> {
    const pending = this.pending.get(owner);
    if (!pending || pending.requestId !== requestId || !pending.request || !pending.expiresAt) {
      throw new Error('This connection request is no longer active. Enter the address to try again.');
    }
    if (Date.now() >= pending.expiresAt) { this.cancel(owner); return { status: 'expired' }; }
    if (pending.polling) return pending.polling;
    const request = pending.request;
    pending.polling = (async () => {
      const result = await this.deps.poll(request, { signal: pending.controller.signal });
      if (this.pending.get(owner) !== pending) throw new Error('The connection request was cancelled.');
      if (result.status === 'pending') return result;
      this.cancel(owner);
      if (result.status !== 'approved') return result;
      return { status: 'approved', name: this.deps.add(result.pairing).name };
    })();
    try { return await pending.polling; }
    finally { pending.polling = undefined; }
  }
}
