/** Adopt the engine's local pairing into the ordinary registry, without waking WSL. */
import * as fs from 'fs';
import { CrucibleClient, type Pairing } from '@crucible/client';
import { processPairingFileHost, readCruciblePairingFile } from './pairing-file';
import { addServer, listServers, registryPath } from './servers';

export interface AutoConnectDeps {
  registryExists(): boolean;
  pairing(): Pairing | null;
  list(): Array<{ name: string; url: string }>;
  verify(pairing: Pairing): Promise<void>;
  add(pairing: Pairing): { name: string };
}
const defaults: AutoConnectDeps = {
  registryExists: () => fs.existsSync(registryPath()),
  pairing: () => readCruciblePairingFile(processPairingFileHost())?.pairing ?? null,
  list: listServers,
  verify: async (pairing) => {
    const info = await new CrucibleClient({ ...pairing, clientName: 'BookForge' }).info();
    if (info.server.name !== pairing.name || info.server.apiVersion !== 1) {
      throw new Error('The local Crucible identity does not match its connect code. Open Crucible to repair the connection.');
    }
  },
  add: addServer,
};

/** Fresh registry only on startup; an explicit install also connects its engine. */
export async function autoConnectLocal(
  afterInstall = false, deps: AutoConnectDeps = defaults,
): Promise<string | null> {
  // An existing empty registry may mean the user deliberately removed a server.
  if (!afterInstall && deps.registryExists()) return null;
  const pairing = deps.pairing();
  if (pairing === null) {
    if (afterInstall) throw new Error('Crucible installed but did not write its connect code. Open Crucible and try connecting again.');
    return null;
  }
  const sameAddress = deps.list().find((row) => new URL(row.url).origin === new URL(pairing.url).origin);
  if (sameAddress) return sameAddress.name;
  await deps.verify(pairing);
  // Re-read after verification: another connection may have landed in the meantime.
  const existing = deps.list().find((row) => new URL(row.url).origin === new URL(pairing.url).origin);
  if (existing) return existing.name;
  return deps.add(pairing).name;
}
