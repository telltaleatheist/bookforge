/**
 * engine-settings-card — where the text work runs, decided in the engine.
 *
 * ── The ruling this card is ────────────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"Bookforge and foundry setup/settings should be able to
 * configure crucible settings. If the user enters an anthropic api key, it
 * should pass through to crucible … the user shouldn't have to interact with
 * crucible almost at all but should have access to it if they want to."* And
 * the addition BookForge put to him, which he agreed: the GPU engine is the
 * SINGLE SOURCE OF TRUTH — a key entered here is saved in the engine, and
 * BookForge uses the same one, because there is one store and two windows onto
 * it.
 *
 * The contract is crucible `docs/PHASE15-HOST.md`; this card is its §3.7 panel
 * drawn in Foundry, on §5.2's terms:
 *
 *   *"every control in these sections is a request to the engine, and its
 *   result is the engine's answer re-read. There is no Save button that writes
 *   an app file and syncs later."*
 *
 * So there is no Save button for the card as a whole, no local edit buffer, no
 * `app-settings.json` key behind any of it. Each control is one
 * `PUT /v1/settings`, and what comes back — the whole document, after the write
 * (§3.2) — is what redraws. A card that redrew from what it sent would be
 * showing a route the engine may have refused.
 *
 * ── HIDDEN WHEN THERE IS NO SERVER, AND NOT HIDDEN WHEN HOSTED ────────────
 *
 * An empty registry means there is nothing to draw a window ONTO, and a card of
 * disabled boxes over an absent engine is furniture. Hosted is the opposite
 * case and the card stays: §5.3 — *"Hosted, the settings window is Foundry's
 * card drawn from BookForge's registry selection, so the two apps show one
 * engine's settings"* — and `readRegistry()` in main already answers the HOST's
 * list, so this needs no branch of its own. That is deliberately unlike the
 * Servers card, which is read-only hosted because the registry is somebody
 * else's; the SETTINGS are the engine's either way, and a hosted window editing
 * them is editing the same store from the same distance.
 */
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  LLM_CLASSES,
  defaultEngineServer,
  splitUpstreamModel,
  type LlmClass,
  type SettingsDocument,
  type SettingsPatch,
} from '@shared/engine-settings';
import type { CrucibleServerView } from '@shared/slots';
import { api } from '../../core/foundry';
import {
  EngineUpstreamsComponent,
  type UpstreamApply,
} from '../../components/engine-upstreams/engine-upstreams.component';

/**
 * The reserved value of the free-text option in a class's select.
 *
 * It cannot collide with a real choice: a route is either the literal `local`
 * or an id with a slash in it (PHASE15 §1), and this has neither.
 */
const CUSTOM = 'an-upstream-model';

@Component({
  selector: 'app-engine-settings-card',
  imports: [EngineUpstreamsComponent, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (servers().length > 0) {
      <div class="card">
        <div class="card-head">
          <span class="card-title">Where the text work runs</span>
          @if (working()) { <span class="small">working…</span> }
        </div>

        <p class="detail">
          Cleanup, translation, simplification and analysis each run somewhere. The GPU engine
          (Crucible) decides which, and this is a window onto its own settings — nothing on this
          card is stored in Foundry. BookForge, and the engine's own page, show the same answers.
        </p>

        <!--
          WHICH ENGINE, and only when there is a choice. One server is not a
          decision, and a select with one option in it is a control that teaches
          somebody there is something to choose.
        -->
        @if (servers().length > 1) {
          <label class="field">
            <span class="label">Engine</span>
            <select [ngModel]="chosen()" name="engine-server"
                    (ngModelChange)="choose($event)">
              @for (server of servers(); track server.name) {
                <option [value]="server.name">{{ serverLabel(server) }}</option>
              }
            </select>
          </label>
        }

        @if (doc(); as settings) {
          @if (problem(); as why) { <p class="warn">{{ why }}</p> }

          <!-- ── One row per class ──────────────────────────────────────── -->
          @for (cls of classes; track cls) {
            <div class="route">
              <span class="who">{{ classLabel(cls) }}</span>
              <select class="wide" [name]="'r-' + cls"
                      [disabled]="working()"
                      [ngModel]="selectionFor(cls)"
                      (ngModelChange)="route(cls, $event)">
                <option value="local">{{ localOption(cls) }}</option>
                @for (id of upstreamOptions(); track id) {
                  <option [value]="id">{{ id }}</option>
                }
                <option [value]="customValue">an upstream model…</option>
              </select>
            </div>
            @if (custom() === cls) {
              <div class="route">
                <span class="who"></span>
                <input class="wide" type="text" [name]="'c-' + cls"
                       placeholder="anthropic/claude-sonnet-5"
                       [ngModel]="typed()"
                       (ngModelChange)="typed.set($event)">
                <button class="primary" type="button"
                        [disabled]="working() || typed().trim().length === 0"
                        (click)="routeTyped(cls)">Use it</button>
              </div>
            }
          }

          <p class="small">{{ backendLine(settings) }}</p>

          <!-- ── The three upstream cards, shared with the wizard ───────── -->
          <p class="detail">
            An account the engine forwards to. The key is stored in the engine, never here — the
            box below is empty every time this card is drawn, and the engine will only ever say
            the last four characters of what it holds.
          </p>
          <app-engine-upstreams
            [serverName]="chosen()"
            [doc]="settings"
            [busy]="working()"
            (apply)="applyUpstream($event)" />
        } @else if (problem(); as why) {
          <p class="warn">{{ why }}</p>
        } @else {
          <p class="small">Asking the engine…</p>
        }
      </div>
    }
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
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; flex: 1; }
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }
    .field { display: flex; align-items: center; gap: 8px; }
    .label { font-size: 12px; color: var(--text-secondary); min-width: 64px; }
    .route { display: flex; align-items: center; gap: 6px; }
    .who { font-size: 12px; min-width: 96px; }
    .wide { flex: 1; min-width: 0; }
    .primary {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px; border: none;
      border-radius: var(--radius-sm);
      background: var(--accent); color: var(--text-inverse);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class EngineSettingsCardComponent {
  protected readonly classes = LLM_CLASSES;
  protected readonly custom = signal<LlmClass | null>(null);
  protected readonly customValue = CUSTOM;

  protected readonly servers = signal<CrucibleServerView[]>([]);
  protected readonly chosen = signal('');
  protected readonly doc = signal<SettingsDocument | null>(null);
  protected readonly working = signal(false);
  protected readonly problem = signal<string | null>(null);
  /** The free-text box under a row, while that row's "an upstream model…" is open. */
  protected readonly typed = signal('');

  constructor() {
    if (!api) return;
    void this.load();
  }

  /**
   * The registry, then the chosen engine's document.
   *
   * THE REGISTRY IS READ THROUGH `crucible:settings`, which hosted answers the
   * HOST's list (electron/crucible-registry.ts's `readRegistry`). That is the
   * whole of what §5.3 asks of this card: one engine, two apps, and no branch
   * here that knows the difference.
   */
  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.servers.set(view.servers);
    if (this.chosen().length === 0) {
      this.chosen.set(defaultEngineServer(view.servers)?.name ?? '');
    }
    if (this.chosen().length > 0) await this.read();
  }

  /** One read of the engine's document. A failure is drawn, never swallowed. */
  private async read(): Promise<void> {
    if (!api) return;
    this.working.set(true);
    try {
      this.doc.set(await api.crucible.engineSettings(this.chosen()));
      this.problem.set(null);
    } catch (err) {
      this.doc.set(null);
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.working.set(false);
    }
  }

  protected choose(name: string): void {
    this.chosen.set(name);
    this.doc.set(null);
    this.custom.set(null);
    void this.read();
  }

  protected serverLabel(server: CrucibleServerView): string {
    return server.enabled ? server.name : `${server.name} (switched off)`;
  }

  protected classLabel(cls: LlmClass): string {
    switch (cls) {
      case 'clean': return 'Cleanup';
      case 'translate': return 'Translation';
      case 'simplify': return 'Simplification';
      case 'analysis': return 'Analysis';
    }
  }

  /**
   * The `local` option's words for ONE class — §3.7 spells it *"local —
   * <selected local model or 'nothing fits'>"*.
   *
   * THE MODEL IS THE DOCUMENT'S, never a guess. §3.1 puts the selected local
   * model in the route row *"so a window can show 'translate: local,
   * qwen3.8-27b-4bit' without a second call"*, and `null` there is a real
   * answer: nothing on that card is big enough.
   *
   * ── AND A CLASS THAT IS CURRENTLY UPSTREAM SAYS ONLY "local" ─────────────
   *
   * Because that is all the document knows. For `route: "upstream"` the row's
   * `model` is the UPSTREAM id, and the local answer is not in
   * `GET /v1/settings` at all — §3.3 keeps it, in the capability row's `reason`
   * after *"the local answer would be:"*, which is a second call this card does
   * not make for a label. Printing the upstream id beside the word "local", or
   * borrowing another class's model, would both be confidently wrong.
   */
  protected localOption(cls: LlmClass): string {
    const row = this.doc()?.routes[cls];
    if (row === undefined || row.route !== 'local') return 'local';
    return row.model === null ? 'local — nothing fits' : `local — ${row.model}`;
  }

  /**
   * Every upstream model id THIS ENGINE ALREADY ROUTES SOMETHING TO.
   *
   * §3.7's middle group: *"each configured upstream's routed model"*. It is the
   * list rather than a catalog because there is no catalog — §2: *"the server
   * does not ship a cloud model list"* — and because the useful case is the
   * second class: somebody who routed translation to a model wants simplify on
   * the same one with a single press, not by retyping an id.
   */
  protected readonly upstreamOptions = computed<string[]>(() => {
    const settings = this.doc();
    if (settings === null) return [];
    const ids = LLM_CLASSES
      .map((cls) => settings.routes[cls])
      .filter((row) => row.route === 'upstream' && row.model !== null)
      .map((row) => row.model as string)
      .filter((id) => {
        const split = splitUpstreamModel(id);
        return split !== null && settings.upstreams[split.upstream].configured;
      });
    return [...new Set(ids)];
  });

  /** Which option a row's select is sitting on right now. */
  protected selectionFor(cls: LlmClass): string {
    if (this.custom() === cls) return CUSTOM;
    const row = this.doc()?.routes[cls];
    if (row === undefined || row.route === 'local' || row.model === null) return 'local';
    return this.upstreamOptions().includes(row.model) ? row.model : CUSTOM;
  }

  /**
   * A row's select changed — which is a WRITE, immediately, except for the one
   * option that is a question rather than an answer.
   *
   * "an upstream model…" opens a box; nothing is sent until somebody says what
   * the model is, because `<upstream>/` with nothing after it is exactly what
   * §3.2 refuses as `route_bad_model`.
   */
  protected route(cls: LlmClass, value: string): void {
    if (value === CUSTOM) {
      this.custom.set(cls);
      this.typed.set('');
      return;
    }
    this.custom.set(null);
    void this.put({ routes: { [cls]: value } });
  }

  protected routeTyped(cls: LlmClass): void {
    const value = this.typed().trim();
    if (value.length === 0) return;
    this.custom.set(null);
    void this.put({ routes: { [cls]: value } });
  }

  /**
   * Save or Remove on an upstream card — one PUT, and the card redraws from its
   * answer.
   *
   * THE MODEL IS IGNORED HERE and the child is not asked for one
   * (`wantsModel` is false): on this card the model is chosen on the class rows,
   * where the question is "what runs translation" rather than "what is this key
   * for". The wizard asks the same child for both, because its one press has to
   * configure and route together (§5.2).
   */
  protected applyUpstream(event: UpstreamApply): void {
    if (event.upstreams === undefined || Object.keys(event.upstreams).length === 0) return;
    void this.put({ upstreams: event.upstreams });
  }

  /**
   * ONE WRITE, AND THE ANSWER IS THE NEW TRUTH.
   *
   * §3.2: the PUT's response is the whole document after the write, so nothing
   * here re-reads and nothing merges. A refusal is drawn as the engine worded
   * it, with the field main's `refusalSentence` named in front of it, and the
   * document on screen is left exactly as it was — because it is still what the
   * engine holds.
   */
  private async put(patch: SettingsPatch): Promise<void> {
    if (!api || this.chosen().length === 0) return;
    this.working.set(true);
    try {
      this.doc.set(await api.crucible.engineSettingsPut(this.chosen(), patch));
      this.problem.set(null);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.working.set(false);
    }
  }

  /**
   * What the engine is, under the rows — and in host mode that is the whole
   * story of why every local option says nothing fits.
   *
   * §3.5: a `backend_kind` of `none` is a Windows machine with no WSL2, which
   * has no accelerator at all; the four classes above are the only work it can
   * do, and they can only be done upstream.
   */
  protected backendLine(settings: SettingsDocument): string {
    const allowance = Math.round(settings.desktopAllowanceBytes / 1e8) / 10;
    if (settings.backendKind === 'none') {
      return 'This engine has no accelerator (host mode), so the work above runs upstream or not at all.';
    }
    return `Engine backend: ${settings.backendKind}. It leaves ${allowance} GB of its card to the desktop.`;
  }

}
