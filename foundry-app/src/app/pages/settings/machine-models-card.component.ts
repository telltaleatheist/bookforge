/**
 * machine-models-card — every store of weights on this machine, with sizes.
 *
 * ── WHY A ROW THAT MOSTLY CANNOT DO ANYTHING ────────────────────────────────
 *
 * docs/SLOTS.md §5b, Owen: *"id really rather not have multiple copies of
 * gigantic models floating around."* They cannot be shared — ollama holds
 * quantised GGUF blobs, a Crucible on WSL holds safetensors for vLLM, a Crucible
 * on a Mac holds MLX weights, and the 27B in each is a different file — so the
 * only thing this screen can honestly do about duplication is SHOW it. §5b's
 * last bullet asks for exactly that: *"a 'Models on this machine' settings row
 * lists every store the app knows… with sizes, so duplication is seen rather
 * than discovered from a full disk."*
 *
 * ── ONE REMOVE BUTTON, ON THE ONE STORE FOUNDRY OWNS ────────────────────────
 *
 * Foundry's own downloads — the llama.cpp build and the two dots.ocr GGUF files
 * — are the only things this app put on the disk, so they are the only things it
 * offers to take off. Ollama's list is drawn beside them with NO button at all:
 * Owen, *"ollama has its own thing going on and we should leave it be"*, and a
 * Remove here would be this app reaching into another program's store to make a
 * number on a screen smaller.
 *
 * THE REMOVAL SAYS WHAT IT FREED, always, and the sentence comes from main
 * (`RemovalOutcome.detail`) rather than being composed here from the number:
 * main is what knows whether the directory could be measured before it went, and
 * a card inventing "freed 0 GB" over an unmeasurable one would be worse than the
 * truth, which is that it could not say.
 *
 * ── AND A CRUCIBLE LINE, WHICH IS NOW A REAL ONE ────────────────────────────
 *
 * The third store is a local Crucible's residency, read from that server's own
 * capability record. Its models carry NO SIZES and that is not an omission: the
 * weights are on the far side of a WSL boundary, or are MLX weights in a Mac's
 * own cache, and this app has measured none of them. Naming what the server
 * serves is the honest half and is also the useful half — somebody looking at
 * this screen is asking whether the 27B is on this machine twice.
 *
 * ── AND THE ONE SENTENCE ABOUT A DELETION THIS APP MADE BY ITSELF ───────────
 *
 * docs/SLOTS.md §5b: when a LOCAL Crucible takes over page reading, Foundry
 * removes its own copy of the reader — *"and never silently: the settings row
 * says what was removed and the gigabytes freed."* That sentence is
 * `MachineModels.pageReader.detail`, composed in main and printed here, and it
 * survives the app being closed because main writes it down. The REMOTE case is
 * the other half of the same rule: nothing is removed, and the row offers it
 * with a number on it and says which machine page reading would then need.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { MachineModels } from '@shared/types';

import { api } from '../../core/foundry';

@Component({
  selector: 'app-machine-models-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <header class="head">
        <h2>Models on this machine</h2>
        @if (inventory(); as it) {
          <span class="pill">{{ total(it) }}</span>
        }
      </header>

      @if (inventory(); as it) {
        <!--
          §5b's SENTENCE, ABOVE THE STORES. Above rather than inside Foundry's
          own store, because in the case that matters most — the automatic
          removal — that store is EMPTY, and a sentence explaining an absence has
          to be somewhere a person will read before they conclude the download
          failed.
        -->
        @if (it.pageReader.server !== null) {
          <div class="offer">
            <p class="detail">{{ it.pageReader.detail }}</p>
            <div class="actions">
              <button class="ghost danger" [disabled]="busy()" (click)="remove()">
                {{ busy() ? 'Removing…' : freeing(it) }}
              </button>
            </div>
          </div>
        } @else {
          <!--
            NO BUTTON, because a null server means removing is not a choice this
            screen may offer: either there is nothing to remove, or the copy on
            this disk is the one still doing the work. The sentence is main's
            either way, and it is drawn whichever of those two it is saying.
            (NO BACKTICKS ANYWHERE IN THIS TEMPLATE — it is a template literal,
            and one would end it mid-comment. A house pitfall.)
          -->
          <p class="detail">{{ it.pageReader.detail }}</p>
        }

        @for (store of it.stores; track store.id) {
          <div class="store">
            <div class="store-head">
              <span class="store-name">{{ store.label }}</span>
              @if (store.bytes !== null && store.items.length > 0) {
                <span class="small mono">{{ size(store.bytes) }}</span>
              }
            </div>
            <p class="detail">{{ store.detail }}</p>

            @if (store.items.length > 0) {
              <ul class="files">
                @for (item of store.items; track item.name) {
                  <li>
                    <span class="name mono">{{ item.name }}</span>
                    <span class="small mono">
                      @if (item.bytes !== null) { {{ size(item.bytes) }} } @else { size unknown }
                    </span>
                    <span class="small">{{ item.detail }}</span>
                  </li>
                }
              </ul>
            }

            <!--
              THE ONLY BUTTON ON THIS CARD, and only on the store this app wrote.
              \`removable\` is main's answer and not a guess made here: it is false
              for Ollama by rule and false for Foundry's own store when there is
              nothing in it to remove.
            -->
            @if (store.removable) {
              <div class="actions">
                <button class="ghost danger" [disabled]="busy()" (click)="remove()">
                  {{ busy() ? 'Removing…' : 'Remove Foundry\\'s downloads' }}
                </button>
                <span class="small">Installing the page reader again downloads them back.</span>
              </div>
            }
          </div>
        }

        @if (said(); as sentence) { <p class="detail">{{ sentence }}</p> }

        <p class="small mono">Catalog: {{ it.generatedBy }} · {{ it.generatedAt }}</p>
      } @else {
        <p class="detail">Measuring…</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .head { display: flex; align-items: center; gap: 8px; }
    .head h2 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; }
    .pill {
      font-size: 11px; padding: 2px 8px; border-radius: 10px;
      background: var(--bg-input); color: var(--text-secondary);
    }

    .offer {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px;
      background: var(--bg-sunken); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    .store { display: flex; flex-direction: column; gap: 6px; }
    .store + .store { border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    .store-head { display: flex; align-items: baseline; gap: 8px; }
    .store-name { font-size: 12px; font-weight: 600; }

    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { font-size: 11px; color: var(--text-tertiary); }
    .mono { font-family: var(--font-mono); word-break: break-word; }

    .files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .files li { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    .files .name { min-width: 0; }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    .danger { color: var(--warn); }
  `],
})
export class MachineModelsCardComponent {
  protected readonly inventory = signal<MachineModels | null>(null);
  protected readonly busy = signal(false);
  /** What the last removal did, in main's own words. Null until one happens. */
  protected readonly said = signal<string | null>(null);

  constructor() {
    if (!api) return;
    void this.load();
    /*
     * THE FILES CAN MOVE WITHOUT THIS CARD DOING IT. Registering the Crucible on
     * this machine takes page reading over, and §5b's removal fires from main —
     * so without this the card would go on listing four gigabytes of files that
     * are not there until somebody navigated away and back.
     */
    api.models.onChanged(() => { void this.load(); });
  }

  private async load(): Promise<void> {
    if (!api) return;
    this.inventory.set(await api.models.inventory());
  }

  /**
   * Remove Foundry's own downloads, then re-measure.
   *
   * THE SENTENCE IS MAIN'S AND THE NUMBER IS IN IT. The card does not compose
   * "freed 3.2 GB" from `freedBytes`, because main is the only thing that knows
   * whether the directory could be measured before it went — and an unmeasurable
   * one has to say so rather than print a zero.
   *
   * NO CONFIRMATION CARD, and that is a judgement rather than an oversight: what
   * this deletes is re-downloadable from its published source, the button says
   * so beside itself, and the app already reserves the confirm-and-name-it
   * gesture for the one deletion that is irreversible (`capture:remove`, the
   * photographs).
   */
  protected async remove(): Promise<void> {
    if (!api) return;
    this.busy.set(true);
    try {
      const outcome = await api.models.removePageReader();
      this.said.set(outcome.detail);
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The remote offer's button, with the number on it.
   *
   * §5b asks for *"removal with a number on it"*, and the number is the only
   * thing this card composes rather than takes from main — because it is a
   * label on a button rather than a claim about what happened. An unmeasurable
   * directory falls back to the plain verb: this card will not print a
   * confident size it does not have.
   */
  protected freeing(inventory: MachineModels): string {
    const bytes = inventory.pageReader.bytes;
    return bytes === null || bytes <= 0
      ? 'Remove the page reader Foundry downloaded'
      : `Remove Foundry's page reader (frees ${this.size(bytes)})`;
  }

  /** Every store's bytes added up, or a sentence when any of them is unknown. */
  protected total(inventory: MachineModels): string {
    let sum = 0;
    for (const store of inventory.stores) {
      if (store.items.length === 0) continue;
      if (store.bytes === null) return 'size partly unknown';
      sum += store.bytes;
    }
    return sum === 0 ? 'nothing here yet' : this.size(sum);
  }

  /** `page-reader-card`'s own scale, so two cards on one screen agree. */
  protected size(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }
}
