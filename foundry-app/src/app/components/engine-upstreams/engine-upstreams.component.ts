/**
 * engine-upstreams — the three upstream cards, drawn once and mounted twice.
 *
 * ── Why it is a child and not markup in two places ─────────────────────────
 *
 * The AI pane (pages/settings/ai-pane.component.ts, where it is the Accounts
 * block at the foot) and the
 * setup wizard's routes step both offer *"run it through Anthropic / OpenAI / an
 * Ollama server instead"* (crucible docs/PHASE15-HOST.md §5.2), and both draw
 * the same three cards: a key or url box, Test, Save, and — when the engine says
 * that upstream is configured — the four-character hint and a Remove. Two copies
 * of that is what `app-crucible-doors` was made a child to stop: the wizard and
 * the Servers card teaching different things about one registry.
 *
 * ── IT OWNS TEST AND NOTHING ELSE ─────────────────────────────────────────
 *
 * Test is identical in both hosts — one unbilled read of the upstream's own
 * model listing — so it happens here. THE WRITE DOES NOT. §5.2 has the wizard
 * making *"one PUT that configures the upstream AND sets the route(s)"*, and
 * §3.2 is what makes that safe: *"upstreams are applied, then routes, then the
 * whole is validated; a refusal applies nothing."* A child that issued its own
 * PUT would turn that one press into two requests, and the failure mode is a key
 * stored against routes that were refused. So Save EMITS the upstreams half of a
 * patch and the host composes the rest.
 *
 * ── THE KEY BOX IS EMPTY ON EVERY DRAW ────────────────────────────────────
 *
 * §3.1: *"A key is write-only … there is no route that returns a key."* This
 * component has never been told one and cannot be — the document carries
 * `keyHint`, the last four characters, and that is all. Every typed value is
 * cleared the moment a new document arrives, so a redraw after a save never
 * leaves a credential sitting in an input.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  UPSTREAM_LABEL,
  UPSTREAM_NAMES,
  type SettingsDocument,
  type SettingsPatch,
  type UpstreamName,
  type UpstreamTestResult,
} from '@shared/engine-settings';
import { api } from '../../core/foundry';

/**
 * WHAT ONE PRESS OF Save OR Remove MEANS, for the host to fold into a patch.
 *
 * `upstreams` IS ALREADY PATCH-SHAPED — `{anthropic: {key}}` to set, `{anthropic:
 * null}` to remove, and `{}` when the stored credential is being kept and the
 * press was only ever about the route. Three states rather than two, because
 * "leave it alone" and "delete it" are different instructions that a nullable
 * field cannot tell apart, and getting them the wrong way round removes the key
 * somebody is trying to use.
 */
export interface UpstreamApply {
  upstream: UpstreamName;
  upstreams: SettingsPatch['upstreams'];
  /**
   * The model id chosen out of Test's listing, when the host asked for one
   * ({@link EngineUpstreamsComponent.wantsModel}). Null when it did not, or
   * when nobody chose. The host makes `<upstream>/<model>` out of it.
   */
  model: string | null;
}

@Component({
  selector: 'app-engine-upstreams',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (name of upstreams; track name) {
      <div class="upstream">
        <div class="row">
          <span class="who">{{ label(name) }}</span>
          @if (configured(name)) {
            <span class="badge">connected</span>
            <span class="small mono">{{ hint(name) }}</span>
          }
          <span class="spacer"></span>
          @if (configured(name)) {
            <button class="ghost" type="button" [disabled]="busy()"
                    (click)="remove(name)">Remove</button>
          }
        </div>

        <!--
          ONE BOX, AND WHICH KIND IT IS IS THE UPSTREAM'S OWN FACT. PHASE15 §2:
          ollama has "no key; ollama is reached by address". A password box for
          an address would hide the one thing a person needs to read back.
        -->
        <div class="row">
          @if (name === 'ollama') {
            <input class="wide" type="text" [name]="'u-' + name"
                   [placeholder]="addressHint()"
                   [ngModel]="typed()[name]"
                   (ngModelChange)="type(name, $event)">
          } @else {
            <input class="wide" type="password" [name]="'u-' + name"
                   [placeholder]="keyHintFor(name)"
                   [ngModel]="typed()[name]"
                   (ngModelChange)="type(name, $event)">
          }
          <button class="ghost" type="button"
                  [disabled]="busy() || testing() === name"
                  (click)="test(name)">
            {{ testing() === name ? 'Testing…' : 'Test' }}
          </button>
          <button class="primary" type="button"
                  [disabled]="busy() || !canSave(name)"
                  (click)="save(name)">{{ applyLabel() }}</button>
        </div>

        @if (results()[name]; as result) {
          @if (result.outcome === 'ok') {
            @if (result.models.length === 0) {
              <p class="small warn">
                That answered, and listed no models. Nothing here can name one for you.
              </p>
            } @else {
              <p class="small ok">{{ listedLine(result.models) }}</p>
              @if (wantsModel()) {
                <!--
                  THE MODEL COMES OUT OF THAT LISTING AND NOWHERE ELSE. PHASE15
                  §2: the engine "does not ship a cloud model list", and neither
                  does this app - a catalog compiled into a build is wrong by the
                  next release, offering models that have been retired and hiding
                  the one somebody is paying for.
                -->
                <select class="wide" [name]="'m-' + name"
                        [ngModel]="model()[name]"
                        (ngModelChange)="pick(name, $event)">
                  <option value="">Pick the model to use…</option>
                  @for (id of result.models; track id) {
                    <option [value]="id">{{ id }}</option>
                  }
                </select>
              }
            }
          } @else {
            <!-- The engine's own words, kept whole: it is the thing that knows
                 whether the key was rejected or nothing answered at all. -->
            <p class="small warn">{{ result.message }}</p>
          }
        }
      </div>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 8px; }
    .upstream {
      display: flex; flex-direction: column; gap: 6px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 8px;
    }
    .row { display: flex; align-items: center; gap: 6px; }
    .who { font-size: 12px; font-weight: 600; }
    .spacer { flex: 1; }
    .wide { flex: 1; min-width: 0; }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; }
    .mono { font-family: var(--font-mono); }
    .warn { color: var(--warn); }
    .ok { color: var(--ok); }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ok); background: var(--ok-soft); border-radius: 999px; padding: 2px 8px;
    }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .primary { border: none; background: var(--accent); color: var(--text-inverse); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost { background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary); }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class EngineUpstreamsComponent {
  /** Which registered server these cards write to. Empty disables every press. */
  readonly serverName = input('');
  /** The engine's document, as the host last read it. Null before the first read. */
  readonly doc = input<SettingsDocument | null>(null);
  /** The host is mid-request; nothing here may start a second one. */
  readonly busy = input(false);
  /**
   * Whether a model must be chosen alongside the credential.
   *
   * TRUE IN THE WIZARD, false in the settings card. §5.2's wizard step makes
   * *"one PUT that configures the upstream AND sets the route(s)"*, and a route
   * is an upstream model id — so that press needs a model. The settings card's
   * models are picked on the per-class rows instead, where the question is
   * "what runs this class" rather than "what is this key for".
   */
  readonly wantsModel = input(false);
  /** What Save says. The wizard's press does more, so it says more. */
  readonly applyLabel = input('Save');

  readonly apply = output<UpstreamApply>();

  protected readonly upstreams = UPSTREAM_NAMES;

  /** What somebody has typed, per upstream. Cleared whenever a document lands. */
  protected readonly typed = signal<Record<string, string>>({});
  protected readonly model = signal<Record<string, string>>({});
  protected readonly results = signal<Record<string, UpstreamTestResult>>({});
  protected readonly testing = signal<UpstreamName | null>(null);

  /** The current document's ollama address, for the box's placeholder. */
  private readonly ollamaUrl = computed(() => this.doc()?.upstreams.ollama.url ?? null);

  constructor() {
    /*
     * A NEW DOCUMENT EMPTIES EVERY BOX.
     *
     * The host redraws from the engine's answer after every write, so a
     * document landing means a press took. Leaving the key in the input would
     * leave a credential on screen (and in the DOM) long after it was needed,
     * which is the one thing §3.1's write-only rule exists to prevent. The
     * listings go too: they were measured against a credential that is no
     * longer the one in the box.
     */
    effect(() => {
      this.doc();
      this.typed.set({});
      this.model.set({});
      this.results.set({});
    });
  }

  protected label(name: UpstreamName): string {
    return UPSTREAM_LABEL[name];
  }

  protected configured(name: UpstreamName): boolean {
    return this.doc()?.upstreams[name].configured ?? false;
  }

  /** The four characters the engine will admit to, or the address for ollama. */
  protected hint(name: UpstreamName): string {
    const document = this.doc();
    if (document === null) return '';
    if (name === 'ollama') return document.upstreams.ollama.url ?? '';
    return document.upstreams[name].keyHint ?? '';
  }

  protected keyHintFor(name: UpstreamName): string {
    return this.configured(name)
      ? 'API key: set — type a new one to replace it'
      : 'API key';
  }

  protected addressHint(): string {
    const url = this.ollamaUrl();
    return url === null ? 'Address — http://192.0.2.20:11434' : `Address — ${url}`;
  }

  protected type(name: UpstreamName, value: string): void {
    this.typed.update((all) => ({ ...all, [name]: value }));
  }

  protected pick(name: UpstreamName, value: string): void {
    this.model.update((all) => ({ ...all, [name]: value }));
  }

  /** Enough of a listing to recognise it by, never the whole of a long one. */
  protected listedLine(models: readonly string[]): string {
    const shown = models.slice(0, 6).join(', ');
    const tail = models.length > 6 ? `, and ${models.length - 6} more` : '';
    return `${models.length} models: ${shown}${tail}`;
  }

  /**
   * MAY Save BE PRESSED — and it is not simply "is there text in the box".
   *
   * Nothing typed and nothing configured is a press that would send an empty
   * patch. Nothing typed but already configured is legal in the wizard, where
   * the press is about the ROUTE and the stored credential is kept; in the
   * settings card there is nothing left for it to do, so it stays off.
   */
  protected canSave(name: UpstreamName): boolean {
    if (this.serverName().length === 0) return false;
    const entered = (this.typed()[name] ?? '').trim().length > 0;
    if (!this.wantsModel()) return entered;
    const chosen = (this.model()[name] ?? '').length > 0;
    return chosen && (entered || this.configured(name));
  }

  /**
   * Test the credential AS IT IS ON SCREEN, saved or not.
   *
   * An empty box tests the CONFIGURED one — §3.2's body is optional and absent
   * means "the one you have". That is what makes the button useful on a card
   * nobody has typed into: "is the key I saved last week still good".
   */
  protected async test(name: UpstreamName): Promise<void> {
    const server = this.serverName();
    if (!api || server.length === 0) return;
    const entered = (this.typed()[name] ?? '').trim();
    const probe = entered.length === 0
      ? undefined
      : (name === 'ollama' ? { url: entered } : { key: entered });
    this.testing.set(name);
    try {
      const result = await api.crucible.engineUpstreamTest(server, name, probe);
      this.results.update((all) => ({ ...all, [name]: result }));
    } catch (err) {
      /*
       * A THROW HERE IS ABOUT THE ENGINE, NOT THE KEY — an unreachable server,
       * a token the registry no longer has. It is drawn in the same place
       * because that is where somebody is looking, and it says what it is.
       */
      this.results.update((all) => ({
        ...all,
        [name]: {
          outcome: 'failed',
          code: 'engine_unreachable',
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      this.testing.set(null);
    }
  }

  protected save(name: UpstreamName): void {
    const entered = (this.typed()[name] ?? '').trim();
    const credential = entered.length === 0
      ? {}
      : { [name]: name === 'ollama' ? { url: entered } : { key: entered } };
    const chosen = this.model()[name] ?? '';
    this.apply.emit({
      upstream: name,
      upstreams: credential as SettingsPatch['upstreams'],
      model: chosen.length === 0 ? null : chosen,
    });
  }

  /**
   * REMOVE — and the engine is the thing that refuses it.
   *
   * §3.2: *"Removing one that a route names is refused `upstream_in_use` with
   * the classes that name it."* Nothing here checks first: a guess made from a
   * document that is a moment old would either block a legal removal or let an
   * illegal one look like it worked, and the engine's refusal already names the
   * classes to re-route.
   */
  protected remove(name: UpstreamName): void {
    this.apply.emit({
      upstream: name,
      upstreams: { [name]: null } as SettingsPatch['upstreams'],
      model: null,
    });
  }
}
