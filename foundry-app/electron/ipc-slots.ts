/**
 * ipc-slots — cloud keys, the slots, and the act gates.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { actGates } from '@owen/foundry-core/node/act-gates';
import { probeCloud } from '@owen/foundry-core/node/cloud-providers';
import { cloudSettingsView, slotAvailability } from '@owen/foundry-core/node/crucible-registry';
import { type CloudProviderEdit } from '@owen/foundry-core/shared/slots';
import * as queue from '@owen/foundry-core/node/job-queue';
import { saveCloudProviders } from '@owen/foundry-core/node/doors-crucible';

export function registerSlotDoors(): void {
  /*
   * ── THE CLOUD PROVIDERS — Package F's app half (docs/SLOTS.md §3) ─────────
   *
   * THREE DOORS, and a family of their own rather than three more members of
   * `crucible:`. That is this app's own advice taken twice over. Once because a
   * provider IS NOT A CRUCIBLE: it has no capability record, nothing resident,
   * no lease and no busy state, and a card reading `crucible:save` to write an
   * OpenAI key would teach that they are one kind of thing. And once because
   * `crucible:` is a family BookForge does not have and `cloud:` is one neither
   * side has — the cheapest possible answer to the collision audit that is still
   * open (docs/IPC-CHANNELS.md).
   *
   * NO KEY CROSSES IN THE ANSWER DIRECTION, ever. The renderer is told
   * `CloudProviderView.keySet` and may send a new key, which is the whole of
   * what a write-only field means — `crucible:`'s token rule, one registry
   * along.
   */
  ipcMain.handle('cloud:settings', () => cloudSettingsView());
  ipcMain.handle('cloud:save', (_event, providers: CloudProviderEdit[]) => saveCloudProviders(providers));
  /**
   * TEST — the model listing at the provider, and whether the chosen id is in it.
   *
   * IT TAKES THE WHOLE EDIT, unsaved, which is `crucible:test-at`'s argument for
   * a card that has only one Test button: somebody pastes a key and types a
   * model and wants to know whether the pair is right BEFORE it is written to
   * disk, and saving first in order to find out would be this app writing a
   * credential into somebody's settings to answer a question. A key on this wire
   * goes ONE WAY, into main, out of a box somebody is typing in; `apiKey: null`
   * means "the one already stored for this name", and no answer carries either.
   */
  ipcMain.handle('cloud:test', (_event, provider: CloudProviderEdit) => probeCloud(provider));

  /**
   * WHERE WORK MAY GO, for the picker.
   *
   * Its own door rather than a field on `crucible:settings` because the two have
   * different readers and different lifetimes: the settings card reads a picture
   * of a registry it is about to edit, and the queue reads a list of names to
   * draw beside rows. A queue page that had to ask for the registry in order to
   * draw a picker would be a page that needs the token flag and the WSL distro
   * to render a dropdown.
   */
  /*
   * THE LIST AND, WHEN THERE IS ONE, WHY IT IS EMPTY. A bare array told the
   * page "no servers" when the truth could be "there was nobody to ask" — a
   * hosted window whose host has not implemented the registry seam. The two
   * want different sentences, so the answer is typed (`SlotAvailability`,
   * shared/slots.ts) and the picker draws the refusal where the slots would be.
   */
  ipcMain.handle('slots:list', () => slotAvailability());
  /**
   * EVERY ROW OF OURS THAT NAMES THIS SLOT — what the Servers card shows before
   * it offers to move any of them. Owen's rule: told, never moved silently.
   */
  ipcMain.handle('slots:rows-waiting-for', (_event, name: string) =>
    queue.rowsWaitingFor(name));

  // ── What this machine may be asked to do, and what it holds ──────────────
  /*
   * THE TILE GATE, AND IT IS ONE DOOR FOR ALL FIVE ACTS.
   *
   * Owen, 2026-09-15: *"if theres no connected crucible server then tiles should
   * be disabled."* Every fact that decides it lives here — the server registry's
   * capability reads, the cloud providers, the settings file and the page
   * reader's directory — so the answer is composed in main and the renderer draws
   * it. Five acts in one call because they come off ONE snapshot, and a dock
   * asking separately could light Translate beside a Simplify that had just gone
   * dark. The stage gate (shared/stages.ts) is unchanged and still the
   * renderer's: that one is about the book, this one is about the venue.
   */
  ipcMain.handle('acts:gates', () => actGates());
}
