/**
 * job-model — which model this job is sent to, chosen in the dialog that
 * configures it.
 *
 * ── THE RULING (Owen, 2026-10-25), WHICH REVERSES THE ONE BEFORE IT ────────
 *
 * *"put the option the user can pick in a dropdown on the modal that configures
 * the job"*; *"cloud accounts should be listed as an option in every model
 * dropdown if its available, just like 27b or 9b or anything else. however,
 * bookforge should use the last used model as the default. the ideal is that the
 * user wont need to use cloud models because theyre expensive. but it should be
 * there if their system is too weak to run a local model"*; *"keep it at 27b as
 * the max right now"*.
 *
 * Until that day the model was INFORMATION, a line under the server chips
 * (run-target.component.ts), because there was no per-run model in the contract
 * and a button there would have had to write the server's class setting. There
 * is one now — `chosenModel` on the request, honoured by the placement
 * (electron/crucible-dispatch.ts) — so a choice here changes THIS job and
 * nothing else, which is what makes it a control and not a lie.
 *
 * ── WHAT IT DRAWS ─────────────────────────────────────────────────────────
 *
 * One dropdown, two groups: Automatic and the server's own models (biggest
 * first, none over 27B) under the server's name, and every model its upstream
 * accounts serve under "API models", each row ending "(API)". The rows
 * themselves are shared/job-models.ts, mirrored in BookForge, so the two apps
 * offer one list. A cloud row is never the first-run default and never reached
 * by Automatic; it opens chosen only because the person chose it last time.
 *
 * NO BILLING SENTENCE (Owen, 2026-11-02): an API model bills to the chosen
 * server's own API account, and the person is expected to know that; the
 * "(API)" on the row is the whole of it. The yellow line that used to say so
 * wrapped a word a line in the inspector's narrow column and sat over its
 * buttons.
 *
 * ── A SERVER THAT DOES NOT ANSWER, AND ONE THAT REFUSES ──────────────────
 *
 * Weather — main retried inside its budget and the server still did not
 * answer (`JobModelOffer.unreachable`) — is a disabled "Server not reachable"
 * row, and the list is asked for again after {@link REASK_MS}. A refusal (a
 * server not registered, a token refused) is a disabled row carrying the
 * sentence's start, the whole sentence on its title.
 *
 * ── CHANGING THE SERVER KEEPS THE CHOICE ONLY WHERE IT EXISTS ────────────
 *
 * The first list read opens on the remembered choice (`preselected`); every
 * later one keeps what is chosen when the new server offers it and is
 * Automatic otherwise (`choiceOnServer`) — never an id that server has not
 * got.
 *
 * ── WHICH SERVER IT ASKS ──────────────────────────────────────────────────
 *
 * The one the job will wait for: the dialog's pinned engine standalone, and,
 * hosted, the top-ranked one (the host's queue places the row, so there is no
 * pin to follow). Standalone with no engine chosen yet it asks nothing — the
 * run-target above is still deciding, or there is no engine at all and says so.
 *
 * A server that cannot be asked is said BY NAME and the dialog's Start stays off
 * ({@link ready}): a dropdown holding only Automatic would look like a server
 * with no models, and a press made against a list nobody read would be a choice
 * nobody saw.
 */
import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { JobModelOffer } from '@owen/foundry-core/shared/job-model-offer';
import { choiceOnServer, type JobModelKind } from '@owen/foundry-core/shared/job-models';

import { api, hosted } from '../../core/foundry';

@Component({
  selector: 'app-job-model',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (asking()) {
      <div class="field">
        <label class="label" [for]="fieldId()">Model</label>
        @if (problem(); as why) {
          <select [id]="fieldId()" disabled [title]="why"><option>{{ shortly(why) }}</option></select>
        } @else if (unreachable(); as why) {
          <select [id]="fieldId()" disabled [title]="why"><option>Server not reachable</option></select>
        } @else if (offer(); as said) {
          <select [id]="fieldId()" [ngModel]="value()" (ngModelChange)="value.set($event)">
            <optgroup [label]="'On ' + said.list.server">
              @for (choice of onCard(); track choice.value) {
                <option [value]="choice.value">{{ choice.label }}</option>
              }
            </optgroup>
            <!--
              THE API ROWS — the server's upstream accounts. Owen: the ideal is
              that the user will not need them, because they are expensive; they
              are here for a machine too weak to run a local one.
            -->
            @if (cloud().length > 0) {
              <optgroup label="API models" [attr.title]="said.list.cloudNote">
                @for (choice of cloud(); track choice.value) {
                  <option [value]="choice.value">{{ choice.label }} (API)</option>
                }
              </optgroup>
            }
          </select>
        } @else {
          <select [id]="fieldId()" disabled><option>Asking which models it can run…</option></select>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    /* The platform paints a group heading in its own colours on Windows, as it
       does an option (styles.scss says so for option). */
    optgroup { background: var(--bg-input); color: var(--text-tertiary); font-style: normal; }
    optgroup option { color: var(--text-primary); }
    select { width: 100%; min-width: 0; }
  `],
})
export class JobModelComponent {
  /** Which kind of job — what the last choice is remembered under. */
  readonly kind = input.required<JobModelKind>();
  /** The engine the dialog pinned (run-target's two-way server); empty is none yet. */
  readonly server = input<string>('');
  /** The chosen row's value — what the request carries as chosenModel; empty is Automatic. */
  readonly value = model<string>('');
  /** True once a list is read and a row is chosen from it. The dialog's Start waits on it. */
  readonly ready = output<boolean>();
  /**
   * ASK THE TOP-RANKED SERVER WHEN NOTHING IS PINNED. A job dialog has a
   * run-target choosing the engine; the inspector's Ask section has no room
   * for one and runs where the ranking says, so it asks with no pin (the
   * hosted path's question) and is told which server answered on
   * {@link listedOn}, which is where its run is then sent.
   */
  readonly topRanked = input(false);
  /** The server the list was read from, by its registry name, each time one is read. */
  readonly listedOn = output<string>();

  protected readonly offer = signal<JobModelOffer | null>(null);
  protected readonly problem = signal<string | null>(null);
  /** The sentence for a server that did not answer within main's budget; asked again after a wait. */
  protected readonly unreachable = computed(() => this.offer()?.unreachable ?? null);

  /** The server this list is asked of, or null for the top-ranked one; undefined is not asking. */
  private readonly target = computed<string | null | undefined>(() => {
    if (hosted()) return null;
    const pinned = this.server();
    if (pinned.length > 0) return pinned;
    return this.topRanked() ? null : undefined;
  });
  protected readonly asking = computed(() => this.target() !== undefined);
  protected readonly fieldId = computed(() => `job-model-${this.kind()}`);

  protected readonly onCard = computed(() =>
    (this.offer()?.list.choices ?? []).filter((choice) => choice.kind !== 'cloud'));
  protected readonly cloud = computed(() =>
    (this.offer()?.list.choices ?? []).filter((choice) => choice.kind === 'cloud'));
  protected readonly chosen = computed(() =>
    this.offer()?.list.choices.find((choice) => choice.value === this.value()) ?? null);

  /** Bumped per read, so an answer about the engine somebody has just stopped pointing at is dropped. */
  private asked = 0;
  /** True once a list has been read, so a later read keeps the choice where it can (`choiceOnServer`). */
  private readOnce = false;
  /** The wait before asking a server that did not answer again. */
  private again: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const target = this.target();
      const kind = this.kind();
      if (target === undefined) {
        this.offer.set(null);
        this.problem.set(null);
        return;
      }
      void this.read(kind, target);
    });
    effect(() => { this.ready.emit(this.offer() !== null && this.unreachable() === null && this.chosen() !== null); });
    inject(DestroyRef).onDestroy(() => { if (this.again !== null) clearTimeout(this.again); });
  }

  /** A refusal's first sentence, short enough for a dropdown row; the title holds the rest. */
  protected shortly(why: string): string {
    const first = why.split(/(?<=[.:;])\s/)[0] ?? why;
    return first.length > 60 ? `${first.slice(0, 59)}…` : first;
  }

  private async read(kind: JobModelKind, target: string | null): Promise<void> {
    if (!api) return;
    const ticket = ++this.asked;
    if (this.again !== null) { clearTimeout(this.again); this.again = null; }
    this.offer.set(null);
    this.problem.set(null);
    try {
      const offer = await api.crucible.jobModels(kind, target);
      if (ticket !== this.asked) return;
      if (offer.unreachable !== null) {
        // Weather: say so in the box, and ask again after a wait, while this is still the question.
        this.offer.set(offer);
        this.again = setTimeout(() => { if (ticket === this.asked) void this.read(kind, target); }, REASK_MS);
        return;
      }
      this.value.set(this.readOnce ? choiceOnServer(offer.list, this.value()) : offer.preselected);
      this.readOnce = true;
      this.offer.set(offer);
      this.listedOn.emit(offer.list.server);
    } catch (err) {
      if (ticket !== this.asked) return;
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }
}

/** How long a picker waits before asking a server that did not answer again. */
const REASK_MS = 15_000;
