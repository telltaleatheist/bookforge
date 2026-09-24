import {
  ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { DialogService } from '../../../creamsicle-desktop/services/dialog.service';
import { ElectronService } from '../../../core/services/electron.service';
import { SettingsService } from '../../../core/services/settings.service';
import { AiService } from '../../../core/services/ai.service';
import {
  CRUCIBLE_TEXT_ACT_NAMES,
  CRUCIBLE_UPSTREAM_NAMES,
  type CrucibleCapabilityView,
  type CrucibleEngineSettings,
  type CrucibleEngineSettingsPatch,
  type CrucibleEngineSettingsRefusal,
  type CrucibleLocalModelChoice,
  type CrucibleModuleProgress,
  type CrucibleTextActName,
  type CrucibleUpstreamName,
  type CrucibleUpstreamProbe,
} from '@shared/crucible/settings-wire';
import type { CrucibleCatalogRow, CrucibleSubjectKind } from '@shared/crucible/catalog-wire';
import {
  ENGINE_CAPABILITY_UNDECIDED,
  ENGINE_SETTINGS_REFUSED_LEAD,
  bytesWords,
  capabilityClassWords,
  capabilityWords,
  localRouteWords,
  reasonWords,
  routeWords,
  sizeWords,
  upstreamCredentialField,
  upstreamFieldWords,
  upstreamRouteWords,
  upstreamStateWords,
  upstreamTestedWords,
  upstreamWordsLeading,
} from './crucible-words';

/**
 * THE JOBS, GROUPED BY WHAT THE WORK IS -- not by the contract's spelling.
 *
 * A capability class is the ENGINE's name for a lane (`clean`, `align`,
 * `rvc`), and ten of them in one flat list makes four kinds of work look like
 * ten equal things. These groups are this app's reading of them, which is the
 * right owner: the engine decides what it can serve, and an app decides how to
 * put it in front of a person.
 *
 * `voices` marks the group the voice weights belong under, because a voice is
 * what the narration job runs on and they were previously a section of their
 * own at the far end of the page.
 *
 * A CLASS THIS BUILD HAS NEVER HEARD OF STILL APPEARS -- see {@link jobGroups}.
 * The engine is released separately and will grow classes; a list that silently
 * dropped them would hide a capability somebody had paid for in weights.
 */
const JOB_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly classes: readonly string[];
  /**
   * Draw this group's class as the SUBJECTS it chooses between, not as a job
   * row with chips.
   *
   * The distinction is whether the choices are things a person MANAGES. A text
   * model is picked and forgotten; a voice or an RVC model is downloaded,
   * listened to, and deleted when the disk fills. Owen, on seeing narration
   * done this way: *"looks liek voice matching/RVC should be arranged/
   * configured the same way."* They are the same thing, so this is one field
   * rather than two special cases.
   */
  readonly asSubjects?: CrucibleSubjectKind;
}> = [
  { title: 'Text', classes: ['clean', 'translate', 'simplify', 'analysis'] },
  { title: 'Documents', classes: ['pages'] },
  /*
   * NARRATION IS DRAWN AS ITS VOICES, NOT AS A JOB WITH VOICE CHIPS.
   *
   * `asVoices` is what stops the `tts` class getting a chip row of its own.
   * With one it appeared TWICE on the page: seven voice chips beside the job,
   * and the same seven voices as cards underneath. Owen, looking at it: *"does
   * this section make sense to be organized like this"*. It did not.
   *
   * The chip row was also the less useful half. BookForge names the voice on
   * EVERY render -- the narrate modal picks it per book and `voice: string` is
   * required on every door in `crucible/render.ts` -- so the engine's default
   * is a value this app never reads. It still matters to other clients of the
   * same engine, so it is not deleted; it is marked on the voice itself, where
   * there is already a row for that voice.
   */
  { title: 'Narration', classes: ['tts'], asSubjects: 'voice' },
  { title: 'Transcription', classes: ['asr', 'align'] },
  // `rvc` is drawn as its subjects for the same reason `tts` is: they are
  // downloaded and deleted one at a time. `denoise` is not — it is one model
  // that is either there or not, so a job row says it in one line.
  { title: 'Voice matching', classes: ['rvc'], asSubjects: 'rvc' },
  { title: 'Noise removal', classes: ['denoise'] },
];

/**
 * ONE LINE IN A JOB'S LIST OF WHAT IT COULD RUN ON.
 *
 * Composed in the class and drawn without a decision in the template, which is
 * the point: the list mixes three different things -- models on this engine,
 * models it has not downloaded, and accounts it can forward to -- and a
 * template branching on which is which per row is a template nobody can read.
 * They are all the same question, so they are all the same shape.
 */
interface JobOption {
  /** Stable across redraws so the list does not re-create rows as it updates. */
  readonly key: string;
  readonly title: string;
  /** The one line under the title: a size, a reason, or what it is. */
  readonly detail: string;
  /** Is this what the job runs on right now? */
  readonly chosen: boolean;
  /** `use` applies it, `download` fetches it first, `none` is neither. */
  readonly action: 'use' | 'download' | 'none';
  /** A pull in flight for this row, as a sentence, or null. */
  readonly progress: string | null;
  /** For `use`: the model id, or null for Automatic. */
  readonly model: string | null;
  /** True when applying it means ROUTING the class, not choosing a local model. */
  readonly route: boolean;
  /** For `download`: the catalog row to pull. */
  readonly row: CrucibleCatalogRow | null;
}

/**
 * Settings -> AI. THE PAGE IS ABOUT ONE SERVER AT A TIME.
 *
 * -- What Owen asked for, 2026-09-17 ----------------------------------------
 *
 * *"i think this page should be a big set of AI options that are applied to
 * the crucible server the user has selected. at the very top we can make it a
 * dropdown or a set of tabs that displays all available crucible servers.
 * anything we change on the page is applied to the selected crucible server.
 * that can include which models are used for which steps. like the 27b for
 * translate. there should be a translation and a simplify option that lets me
 * pick which model is used for that. it can pick from a list of available
 * models, maybe with a more button that lets the user download other models to
 * the crucible server if they want to use that one instead."* And the same
 * shape for voices.
 *
 * -- TABS, NOT A DROPDOWN ---------------------------------------------------
 *
 * He offered both and has ruled on the general case twice: *"NO DROPDOWNS. i
 * hate drop downs... they're ugly"* (memory settings-belong-to-a-crucible-server).
 * A strip of servers also does a thing a select cannot: it shows how many
 * there are and what each one IS -- backend and card -- without being opened.
 *
 * -- NOTHING ON THIS PAGE IS STORED IN THIS APP -----------------------------
 *
 * PHASE15 section 0: settings live in the engine and nowhere else. Every
 * control here is a window onto GET/PUT /v1/settings or GET /v1/catalog on the
 * SELECTED server, read on every draw and written straight through. The one
 * thing BookForge keeps is WHICH SERVER is selected, because that is a fact
 * about this app and not about any engine.
 *
 * -- WHY THIS PAGE DOES NOT ALSO PICK A MODEL FOR THE APP -------------------
 *
 * It used to be possible to pin aiConfig.crucible.model -- one id, chosen
 * here, sent with every cleanup. That is a SECOND owner of a decision this
 * page now makes four times over (once per class, on the engine), and the two
 * disagreed silently: a model pinned in app settings won over anything chosen
 * for the clean class here. The app no longer stores one. What each class runs
 * on is the engine's answer, asked at the start of a run and stamped onto that
 * run's provenance -- which is what every comment in ai-bridge.ts already said
 * was true and, until 2026-09-17, was not.
 */
@Component({
  selector: 'app-ai-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="aip">

      <!--
        GROUPED BY WHAT THE JOB IS FOR (2026-09-17). Owen: *"can we put some
        items under sections? … can we compeletely rethink how we're organizing
        this data"*.

        NO BACKTICKS IN THIS COMMENT: one ends the template literal and the
        errors then point at unrelated lines.

        Ten capability classes in one flat list is the engine's vocabulary, not
        a person's: clean, align, rvc and denoise sat side by side as equals
        when four of them are one subject (what happens to the text) and two
        are another (what happens to the audio afterwards). So the classes are
        grouped, the groups are named for the work rather than for the
        contract, and a class this build has never heard of still lands in a
        group rather than vanishing.

        The free-text account box is GONE. It asked for an account slash model
        id with nothing to go on -- Owen: *"what would a person even type in
        that?"* -- and the honest answer is that those ids come from Testing an
        account, which then lists them here as ordinary rows. A box that only
        makes sense after you already know the answer is not a control, and its
        stretched height was the second half of the complaint.
      -->
      @if (servers().length === 0) {
        <p class="aip-empty">
          No Crucible server is connected yet, and every AI option on this page belongs to one.
          Add a server in Settings &rarr; Crucible Servers and this page fills in.
        </p>
      } @else {
        <div class="aip-strip" role="tablist">
          @for (name of servers(); track name) {
            <button class="aip-srv" role="tab" [class.on]="name === server()"
                    [attr.aria-selected]="name === server()" (click)="pickServer(name)">
              <span class="aip-srv-name">{{ name }}</span>
              <span class="aip-srv-sub">{{ serverSub(name) }}</span>
            </button>
          }
        </div>

        @if (loading()) {
          <p class="aip-note">Asking {{ server() }} what it has&hellip;</p>
        }
        @if (error(); as message) {
          <div class="aip-banner">
            <p class="aip-bad">{{ message }}</p>
            <desktop-button variant="ghost" size="sm" (click)="reload()">Try again</desktop-button>
          </div>
        }

        <div class="aip-body" [class.stale]="error() !== null">
          @if (panelRefusal(); as r) {
            <p class="aip-bad">
              {{ REFUSED_LEAD }} <span class="aip-code">{{ r.code }}</span> {{ r.message }}
            </p>
          }

          @if (!answered()) {
            <p class="aip-note">{{ NOT_ANSWERED }}</p>
          } @else if (undecided()) {
            <p class="aip-warn">{{ CAPABILITY_UNDECIDED }}</p>
          }

          @for (group of jobGroups(); track group.title) {
            <section class="aip-sec">
              <h3>{{ group.title }}</h3>

              @for (job of group.jobs; track job) {
                <!--
                  THE CHOICES ARE ON THE ROW, NOT BEHIND IT (2026-09-17). Owen:
                  *"we can list the available models as buttons to the right
                  instead of having an accordion wher i hit use. the one
                  selected has a checkmark by it or something."*

                  Change-then-Use was two presses and a state to remember for a
                  choice between three things that fit on one line. Every option
                  is a chip; pressing one applies it; the one in force carries a
                  tick. The size and the reason ride in the title attribute
                  rather than on a second line, which is what made the earlier
                  two-line pills a field the eye had to re-scan.
                -->
                <div class="aip-card">
                  <div class="aip-card-head">
                    <div class="aip-card-info">
                      <h4>{{ actWords(job) }}</h4>
                      <p class="aip-card-sub">{{ jobSummary(job) }}</p>
                    </div>
                    <div class="aip-chips">
                      @for (opt of optionsFor(job); track opt.key) {
                        <button class="aip-chip-btn"
                                [class.on]="opt.chosen"
                                [class.get]="opt.action === 'download'"
                                [attr.title]="chipTitle(opt)"
                                [disabled]="engineBusy() !== null || opt.progress !== null"
                                (click)="pickOption(job, opt)">
                          @if (opt.chosen) { <span class="aip-tick">&#10003;</span> }
                          <span>{{ opt.title }}</span>
                          @if (opt.action === 'download') {
                            <span class="aip-chip-mark">{{ opt.progress ? '&hellip;' : '&#8595;' }}</span>
                          }
                        </button>
                      }
                    </div>
                  </div>

                  @if (jobProgress(job); as line) {
                    <p class="aip-option-progress">{{ line }}</p>
                  }
                  @if (isAct(job) && !anyAccountConfigured()) {
                    <p class="aip-hint">{{ ACCOUNT_HINT }}</p>
                  }
                  @if (fieldRefusal('local_models.' + job); as r) {
                    <p class="aip-bad"><span class="aip-code">{{ r.code }}</span> {{ r.message }}</p>
                  }
                  @if (fieldRefusal('routes.' + job); as r) {
                    <p class="aip-bad"><span class="aip-code">{{ r.code }}</span> {{ r.message }}</p>
                  }
                </div>
              }

              <!--
                THE SUBJECTS OF THIS GROUP, IN TWO COLUMNS. Owen: *"maybe we
                split it into two columns instead of one so it takes up less
                space."* Seven voices at one card per row was most of a screen
                for a list whose rows are a name, a repo and one button.

                One column below 900px, because at that width two columns put
                the repo line and the button on top of each other.
              -->
              @if (group.subjects.length > 0) {
                <div class="aip-grid">
                  @for (row of group.subjects; track row.id) {
                    <div class="aip-card">
                      <div class="aip-card-head">
                        <div class="aip-card-info">
                          <h4>{{ row.name ?? row.id }}</h4>
                          <p class="aip-card-sub">{{ rowWords(row) }}</p>
                          @if (pullOf(row); as prog) {
                            <p class="aip-option-progress">{{ pullWords(prog) }}</p>
                          }
                        </div>
                        <div class="aip-option-act">
                          @if (row.installed) {
                            <!-- WHICH ONE THIS ENGINE FALLS BACK TO, marked on
                                 the subject rather than listed again above.
                                 Nothing in BookForge reads it -- every render
                                 names its own -- but another client of this
                                 engine may, so it stays settable. -->
                            @if (isDefaultSubject(group.subjectClass, row.id)) {
                              <span class="aip-tick">&#10003;</span>
                              <span class="aip-chip-mark">default</span>
                            } @else {
                              <button class="aip-link" [disabled]="engineBusy() !== null"
                                      (click)="makeDefaultSubject(group.subjectClass, row.id)">
                                Make default
                              </button>
                            }
                            <desktop-button variant="ghost" size="sm"
                                            [disabled]="removing() !== null"
                                            (click)="remove(row)">
                              {{ removing() === key(row) ? 'Removing' : 'Remove' }}
                            </desktop-button>
                          } @else {
                            <desktop-button variant="ghost" size="sm"
                                            [disabled]="pullOf(row) !== null"
                                            (click)="download(row)">
                              {{ pullOf(row) ? 'Downloading' : 'Download' }}
                            </desktop-button>
                          }
                        </div>
                      </div>
                    </div>
                  }
                </div>
              }

            </section>
          }

          <section class="aip-sec">
            <h3>Accounts</h3>
            <p class="aip-note">{{ KEYS_NOTE }}</p>

            @for (name of UPSTREAMS; track name) {
              <div class="aip-card">
                <div class="aip-card-head">
                  <div class="aip-card-info">
                    <h4>{{ upstreamTitle(name) }}</h4>
                    <p class="aip-card-sub">{{ upstreamState(name) }}</p>
                    @if (testedWordsFor(name); as line) {
                      <p class="aip-card-sub">{{ line }}</p>
                    }
                  </div>
                  <div class="aip-option-act">
                    @if (isConfigured(name)) {
                      <desktop-button variant="ghost" size="sm" [disabled]="engineBusy() !== null"
                                      (click)="removeUpstream(name)">Remove</desktop-button>
                    }
                    <button class="aip-link" [disabled]="engineBusy() !== null"
                            (click)="toggle('acct:' + name)">
                      {{ open('acct:' + name) ? 'Done' : (isConfigured(name) ? 'Replace' : 'Set up') }}
                    </button>
                  </div>
                </div>

                @if (open('acct:' + name)) {
                  <div class="aip-field">
                    <!-- EMPTY ON EVERY DRAW. A key is write-only: the engine
                         never sends one back, so there is nothing to put in
                         this box, and the drafts are cleared by the one
                         function that draws a document. -->
                    <input class="aip-input" [type]="fieldType(name)" autocomplete="off"
                           spellcheck="false" [value]="draftFor(name)"
                           (input)="setDraft(name, $any($event.target).value)"
                           [placeholder]="fieldPlaceholder(name)" />
                    <desktop-button variant="ghost" size="sm" [disabled]="engineBusy() !== null"
                                    (click)="testUpstreamAccount(name)">Test</desktop-button>
                    <desktop-button variant="primary" size="sm"
                                    [disabled]="engineBusy() !== null || draftFor(name).trim().length === 0"
                                    (click)="saveUpstream(name)">Save</desktop-button>
                  </div>
                }

                @if (fieldRefusal('upstreams.' + name); as r) {
                  <p class="aip-bad"><span class="aip-code">{{ r.code }}</span> {{ r.message }}</p>
                }
              </div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    /*
     * THEME VARIABLES ONLY, NO FALLBACKS, AND NO BACKTICKS IN THIS COMMENT.
     *
     * A backtick here ends the styles template literal and the errors then
     * point at unrelated lines; that happened three times on 2026-09-17 and
     * tools/test-no-backticks-in-templates.js is what now catches it.
     *
     * A default written beside a variable name nobody checked hides a wrong
     * name everywhere the real value would have differed - the Doctor panel
     * shipped white cards in dark mode that way. Every name below is in
     * creamsicle-desktop/styles/_themes.scss; rename one and this panel goes
     * UNSTYLED, which is loud.
     *
     * THE MEASUREMENTS ARE THE DOCTOR PANEL'S, deliberately: 12px 14px inside a
     * card, 8px radius, 1px --border-default on --bg-card, 12px between cards.
     * Two settings pages that are almost the same shape read as a bug.
     */
    .aip { display: flex; flex-direction: column; gap: 20px; }

    .aip-empty, .aip-note { color: var(--text-secondary); font-size: 13px; margin: 0; }
    .aip-bad { color: var(--error-text); font-size: 13px; margin: 6px 0 0; }
    .aip-warn { color: var(--warning-text); font-size: 13px; margin: 0 0 8px; }

    .aip-strip { display: flex; flex-wrap: wrap; gap: 8px; }
    .aip-srv {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      padding: 8px 14px; border-radius: 8px; cursor: pointer; text-align: left;
      border: 1px solid var(--border-default); background: var(--bg-card);
      color: var(--text-primary); min-width: 150px;
    }
    .aip-srv:hover { background: var(--bg-hover); }
    /*
     * THE SELECTED SERVER IS MARKED BY ITS BORDER, NOT BY A FILL. The filled
     * version used --selected-bg (a solid cyan) with --text-primary on top,
     * which Owen could not read. A border says the same thing and cannot go
     * illegible, because the text keeps the colour it already had.
     */
    .aip-srv.on {
      border-color: var(--accent-primary); border-width: 2px; padding: 7px 13px;
      background: var(--bg-elevated);
    }
    .aip-srv-name { font-size: 14px; font-weight: 600; }
    .aip-srv-sub { font-size: 11px; color: var(--text-tertiary); }

    .aip-sec { display: flex; flex-direction: column; gap: 12px; }
    .aip-sec h3 {
      margin: 0; font-size: 15px; color: var(--text-primary);
      padding-bottom: 6px; border-bottom: 1px solid var(--divider);
    }

    .aip-banner {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 10px 12px; border-radius: 8px; border: 1px solid var(--error);
      background: var(--error-bg);
    }
    .aip-banner .aip-bad { margin: 0; }
    /*
     * DIMMED, NOT HIDDEN. When the engine did not answer, the controls below
     * show the LAST document it sent, or nothing - either way they are not
     * live. Fading says so without taking the page away.
     */
    .aip-body { display: flex; flex-direction: column; gap: 20px; }
    .aip-body.stale { opacity: .55; }

    /*
     * TWO COLUMNS FOR SUBJECT LISTS, one for everything else. A job row carries
     * a name, a sentence and a strip of chips and needs the width; a subject
     * row carries a name, a repo and a button and does not.
     */
    .aip-grid {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
    }
    @media (max-width: 900px) { .aip-grid { grid-template-columns: minmax(0, 1fr); } }

    .aip-card {
      padding: 12px 14px; border-radius: 8px; background: var(--bg-card);
      border: 1px solid var(--border-default); color: var(--text-primary);
      display: flex; flex-direction: column; gap: 10px;
    }
    .aip-card-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    }
    .aip-card-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .aip-card-info h4 {
      margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary);
      text-transform: capitalize;
    }
    .aip-card-sub { margin: 0; font-size: 12px; color: var(--text-secondary); }

    .aip-link {
      flex: 0 0 auto; padding: 5px 12px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--border-default); background: var(--bg-input);
      color: var(--text-primary); font-size: 12px;
    }
    .aip-link:hover:not([disabled]) { background: var(--bg-hover); }
    .aip-link[disabled] { opacity: .5; cursor: default; }

    /*
     * THE CHOICES, AS ONE-LINE CHIPS ON THE RIGHT OF THE ROW.
     *
     * Not the two-line pills this page started with: those wrapped into a field
     * the eye had to re-scan, and they needed a filled background to show which
     * was selected, which is what became unreadable. A chip is one line, the
     * selected one is marked by a tick and a border, and the text never changes
     * colour against its background.
     */
    .aip-chips {
      display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px;
      flex: 1 1 auto; max-width: 70%;
    }
    .aip-chip-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 11px; border-radius: 14px; cursor: pointer; white-space: nowrap;
      border: 1px solid var(--border-default); background: var(--bg-input);
      color: var(--text-primary); font-size: 12px; line-height: 1.4;
    }
    .aip-chip-btn:hover:not([disabled]) { background: var(--bg-hover); }
    .aip-chip-btn.on {
      border-color: var(--accent-primary); border-width: 2px; padding: 4px 10px;
      background: var(--bg-elevated); font-weight: 600;
    }
    /* Not on this engine yet: an outline and a down-arrow, so "I have not got
       that one" is visible before the press rather than after it. */
    .aip-chip-btn.get { border-style: dashed; color: var(--text-secondary); }
    .aip-chip-btn[disabled] { opacity: .5; cursor: default; }
    .aip-chip-mark { font-size: 11px; color: var(--text-tertiary); }
    .aip-option-progress { font-size: 11px; color: var(--text-accent); margin: 0; }
    .aip-option-act { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    /* The Doctor's tick, for the same reason: it reads at a glance and needs no
       background to be legible. */
    .aip-tick { color: var(--success); font-size: 16px; }

    .aip-hint {
      margin: 8px 0 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5;
    }

    /*
     * align-items:center IS LOAD-BEARING, and its absence is what Owen
     * photographed: an input inside a flex COLUMN stretches to the column's
     * height, so the account box came out several hundred pixels tall. The
     * control that caused it is deleted, but every input on this page lives in
     * a row and this is what keeps them one line high.
     */
    .aip-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .aip-input {
      flex: 1 1 240px; min-width: 180px; max-height: 32px; padding: 6px 10px; border-radius: 6px;
      border: 1px solid var(--border-input); background: var(--bg-input);
      color: var(--text-primary); font-size: 12px;
    }
    .aip-input:focus { outline: none; border-color: var(--border-accent); }
    .aip-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
      padding: 1px 5px; border-radius: 4px; background: var(--bg-sunken);
      color: var(--text-tertiary);
    }
  `],
})
export class AiPanelComponent implements OnInit {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = inject(DialogService);
  private readonly ai = inject(AiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly ACTS = CRUCIBLE_TEXT_ACT_NAMES;
  readonly UPSTREAMS = CRUCIBLE_UPSTREAM_NAMES;
  /*
   * THE FOUR EXPLANATORY PARAGRAPHS ARE CUT (2026-09-17). Owen, reading the
   * page: *"this info isnt necesasry. if it's superfluous and self explanatory
   * then cut it."*
   *
   * `ENGINE_LOCAL_MODELS_INTRO` explained that the list is the engine's and
   * that you can hand the choice back -- both visible in the Automatic button
   * beside it. `ENGINE_FIT_CAVEAT` spent a paragraph on "fits is an estimate";
   * the card that does not fit says "may not fit this card" on itself, which is
   * the same warning where the decision is. `ENGINE_ROUTES_INTRO` and
   * `TEST_BEFORE_SAVE_WORDS` described what the buttons do.
   *
   * The words still exist for the WIZARD, where somebody is meeting all of this
   * for the first time. A settings page is not a first meeting.
   */
  /**
   * WHERE THE ACCOUNT ROWS COME FROM, said only when there are none.
   *
   * This replaced a free-text box asking for `<account>/<model id>` -- a
   * control whose placeholder was its own documentation and which Owen could
   * not answer: *"what would a person even type in that?"* The ids are the
   * account's own, and the only thing that knows them is a Test.
   */
  readonly ACCOUNT_HINT =
    'To run this on Anthropic, OpenAI or an Ollama server instead, set one up under Accounts '
    + 'below and press Test. The models that account offers then appear here.';

  readonly KEYS_NOTE = 'Keys go to the engine, which is what calls the account. BookForge stores none.';
  readonly REFUSED_LEAD = ENGINE_SETTINGS_REFUSED_LEAD;
  /*
   * THE THREE `ROUTE_CHOICE_OTHER*` WORDS ARE GONE WITH THE BOX THEY LABELLED.
   *
   * It asked for an account-slash-model-id and its help text explained that you
   * get those ids by Testing an account -- at which point they are listed here
   * as ordinary rows, so the box was asking for something it had already been
   * given. They remain in `crucible-words.ts` for the wizard, which still draws
   * the select they were written for.
   */
  /** The value that means "on this engine's own card". The server's spelling. */
  readonly LOCAL_ROUTE = 'local';
  readonly CAPABILITY_UNDECIDED = ENGINE_CAPABILITY_UNDECIDED;


  /**
   * SAID WHERE THE DOWNLOAD LIST IS, not in a tooltip.
   *
   * Owen asked for the voice list to be "connected to hugging face". It is,
   * and this is the whole of how -- every row names the repo its bytes come
   * from and a download fetches that repo onto the server. What it is not is a
   * SEARCH of the Hub: Crucible serves the subjects its manifests declare and
   * has no endpoint that queries HuggingFace, so a box that appeared to search
   * it would be a box that cannot.
   */
  /** Said wherever a list would otherwise read as "the engine has none". */
  readonly NOT_ANSWERED =
    'This engine has not answered yet, so nothing below is its current state. Everything is '
    + 'still here, and Try again re-reads it.';

  readonly HUGGINGFACE_NOTE =
    'Each of these is a HuggingFace repository this engine knows how to fetch. Downloading one '
    + 'pulls it onto the server, not onto this computer.';

  readonly servers = signal<readonly string[]>([]);
  readonly server = signal('');
  readonly engine = signal<CrucibleEngineSettings | null>(null);
  readonly capability = signal<CrucibleCapabilityView | null>(null);
  readonly catalog = signal<readonly CrucibleCatalogRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** The act whose write is in flight, or null. One at a time, deliberately. */
  readonly saving = signal<string | null>(null);
  /** `kind:id` of the subject being removed, or null. */
  readonly removing = signal<string | null>(null);
  /**
   * A NO, PUT WHERE IT BELONGS.
   *
   * PHASE15 section 3.2 pins `details.field` as a dotted path -- `routes.translate`,
   * `upstreams.anthropic.key` -- precisely so a panel can say the sentence
   * beside the control instead of at the top of a page with twenty controls on
   * it. A refusal with no field has nowhere particular to go and goes to the
   * top, which is the truth about it rather than a gap being filled.
   */
  readonly fieldRefusals = signal<Record<string, { code: string; message: string }>>({});
  readonly panelRefusal = signal<CrucibleEngineSettingsRefusal | null>(null);

  /** The control whose engine write is in flight, or null. One at a time. */
  readonly engineBusy = signal<string | null>(null);

  /**
   * WHAT IS TYPED IN A CREDENTIAL BOX, PER ACCOUNT, AND ONLY UNTIL THE NEXT DRAW.
   *
   * Section 5.2: *"A key field is empty on every draw (write-only) with the hint
   * beside it."* {@link redraw} clears this and is the only function that puts a
   * document on screen, so a key cannot survive a Save, a refusal, a re-read or
   * a change of server. It reaches `settings.service.ts` nowhere: this signal
   * and the one request that carries it are the whole of its life here.
   */
  readonly upstreamDrafts = signal<Record<string, string>>({});
  /** What a Test got back, per account. The only source of cloud model ids. */
  readonly testedModels = signal<Record<string, string[]>>({});
  /** Every pull in flight or just finished, keyed `kind:id`. */
  readonly pulls = signal<Record<string, CrucibleModuleProgress>>({});
  private readonly expanded = signal<Record<string, boolean>>({});
  /** Engine-vs-catalog mismatches already reported, so each is said once. */
  private readonly reportedMissingRows = new Set<string>();

  /**
   * The backend has not measured its card, so it offers nothing to choose
   * between anywhere. Said ONCE at the top rather than four times.
   */
  readonly undecided = computed(() => {
    const doc = this.engine();
    // An engine that states no model assignment at all (localModels null) has
    // not said it is undecided — it has said nothing, and nothing is drawn.
    if (doc === null || doc.localModels === null) return false;
    return Object.keys(doc.localModels.choices).length === 0;
  });

  /**
   * EVERY CLASS THIS ENGINE OFFERS A CHOICE FOR, the four text acts first.
   *
   * NOT just the four. `localModels.choices` is keyed by capability class and
   * there are more of them than there are text acts — `pages` reads documents,
   * `tts` narrates, `asr` transcribes — and each has weights that a person may
   * want to choose. Owen named translate and simplify because those are the
   * two he wanted; drawing only those would have silently deleted the others'
   * pickers, which is not what asking for two of them means.
   *
   * The engine's key order is whatever a dict iterated in; the four acts are
   * put first because they are the ones a person came here for, and the rest
   * follow in the engine's own order rather than being sorted into an order
   * this app invented.
   */
  /**
   * The groups, with only the classes THIS engine actually offers, and only
   * the groups that ended up with something in them.
   *
   * The last group is built rather than declared: anything the engine offers
   * that {@link JOB_GROUPS} does not name goes under "Other", so a class added
   * to a future Crucible shows up unsorted instead of not at all.
   */
  readonly jobGroups = computed<ReadonlyArray<{
    title: string;
    jobs: readonly string[];
    subjectKind: CrucibleSubjectKind | null;
    subjectClass: string | null;
    subjects: readonly CrucibleCatalogRow[];
  }>>(() => {
    const present = this.modelClasses();
    const named = new Set(JOB_GROUPS.flatMap((group) => group.classes));
    const groups = JOB_GROUPS
      .map((group) => ({
        title: group.title,
        // `asSubjects` names the class so it is not swept into "Other", and
        // draws none of it as a job: the subject cards below ARE its choices.
        jobs: group.asSubjects === undefined
          ? group.classes.filter((cls) => present.includes(cls))
          : [],
        // The class whose default the subject cards set, so a card can offer
        // "Make default" without the template knowing which group it is in.
        subjectKind: group.asSubjects ?? null,
        subjectClass: group.asSubjects === undefined ? null : group.classes[0],
        subjects: group.asSubjects === undefined ? [] : this.subjectsOfKind(group.asSubjects),
      }))
      // A group with neither jobs nor subjects is not drawn. Narration survives
      // an engine with no tts class when it still holds voices, which is the
      // Windows host case exactly.
      .filter((group) => group.jobs.length > 0 || group.subjects.length > 0);

    const rest = present.filter((cls) => !named.has(cls));
    if (rest.length > 0) {
      groups.push({ title: 'Other', jobs: rest, subjectKind: null, subjectClass: null, subjects: [] });
    }
    return groups;
  });

  /**
   * Is this the subject the engine reaches for when a client does not name one?
   *
   * `cls` rather than a hardcoded `tts`, because the same row shape now draws
   * voices AND rvc models and each has its own capability class. One function
   * that takes the class beats two that differ by a string literal.
   */
  isDefaultSubject(cls: string | null, id: string): boolean {
    if (cls === null) return false;
    return this.engine()?.localModels?.selected[cls] === id;
  }

  /**
   * Make this the engine's default voice.
   *
   * The same `local_models` write every job chip makes, on the `tts` class --
   * which is why it is not a special door. It sends no route: `tts` is not an
   * llm class and answers `local` always, so a route would be refused
   * `route_not_routable`, correctly and pointlessly.
   */
  async makeDefaultSubject(cls: string | null, id: string): Promise<void> {
    if (cls === null) return;
    await this.write('local_models.' + cls, { localModels: { [cls]: id } });
  }

  /** Is any account set up? Decides whether to explain where account rows come from. */
  anyAccountConfigured(): boolean {
    const doc = this.engine();
    if (doc === null) return false;
    return this.UPSTREAMS.some((name) => doc.upstreams[name]?.configured === true);
  }

  readonly modelClasses = computed<readonly string[]>(() => {
    const choices = this.engine()?.localModels?.choices ?? {};
    const present = Object.keys(choices);
    const acts = (CRUCIBLE_TEXT_ACT_NAMES as readonly string[]).filter((a) => present.includes(a));
    const rest = present.filter((key) => !(CRUCIBLE_TEXT_ACT_NAMES as readonly string[]).includes(key));
    return [...acts, ...rest];
  });

  /**
   * HAS THIS ENGINE ANSWERED AT ALL?
   *
   * The page is drawn whether or not it has (Owen: *"all the fields should be
   * present"*), and every control below needs this to tell "the engine said no
   * models" from "the engine said nothing". They look identical in the data --
   * both are an empty list -- and they are opposite sentences to read.
   */
  readonly answered = computed(() => this.engine() !== null);

  /**
   * EVERY VOICE THIS ENGINE COULD HOLD, installed first.
   *
   * ONE LIST, not an installed list plus a "N more voices" expander. The two
   * said the same thing about the same voices and put the one somebody wanted
   * behind an extra press; a voice you have not got is a voice whose button
   * says Download.
   */
  /**
   * EVERY SUBJECT OF ONE KIND THIS ENGINE COULD HOLD, installed first.
   *
   * ONE LIST, not an installed list plus a "N more" expander. The two said the
   * same thing about the same subjects and put the one somebody wanted behind
   * an extra press; a thing you have not got is a row whose button says
   * Download.
   */
  subjectsOfKind(kind: CrucibleSubjectKind): readonly CrucibleCatalogRow[] {
    return [...this.catalog().filter((row) => row.kind === kind)]
      .sort((a, b) => Number(b.installed) - Number(a.installed));
  }

  ngOnInit(): void {
    const stop = this.electron.crucible.onPullProgress((progress) => {
      this.pulls.update((all) => ({ ...all, [progress.kind + ':' + progress.id]: progress.task }));
    });
    this.destroyRef.onDestroy(stop);
    void this.loadServers();
  }

  // -- Reading --------------------------------------------------------------

  private async loadServers(): Promise<void> {
    const res = await this.electron.crucible.servers();
    if (!res.success || !res.data) {
      this.error.set(res.error ?? 'The server list could not be read.');
      return;
    }
    const names = res.data.routing.ranked.filter((row) => row.enabled).map((row) => row.name);
    this.servers.set(names);

    /*
     * THE REMEMBERED SERVER, CHECKED AGAINST THE LIST.
     *
     * A name stored when a server existed is not evidence it still does --
     * forgetting one in Settings -> Crucible Servers leaves this name behind.
     * Drawing the page against it would read a machine that is no longer
     * registered and show its refusal as though the engine were broken.
     */
    const stored = this.settings.getAIConfig().crucible?.server ?? '';
    if (stored !== '' && names.includes(stored)) {
      this.server.set(stored);
      await this.reload();
      return;
    }

    /*
     * NOTHING CHOSEN, OR A NAME THAT IS NO LONGER CONNECTED: TAKE THE FIRST.
     *
     * Owen: *"they should just be populated with the selected one, which will
     * automatically be the first one."* The list is the routing order, so the
     * first row is the engine this app would send work to anyway -- picking it
     * agrees with what the queue already does rather than inventing a
     * preference.
     *
     * A STORED NAME THAT HAS GONE IS SAID, NOT SWALLOWED. It used to take over
     * the page as an error; now the page draws against the server that IS
     * there and the console carries the reason, because the visible outcome --
     * a different server selected than last time -- is the part a person needs
     * to notice, and it is on screen.
     */
    if (stored !== '') {
      console.error(
        `[AI] Settings named a Crucible server called "${stored}" and no server by that name is `
        + `connected any more (known: ${names.join(', ')}). Selecting "${names[0]}".`,
      );
    }
    if (names.length === 0) return;
    this.pickServer(names[0]);
  }

  pickServer(name: string): void {
    if (name === this.server()) return;
    this.server.set(name);
    /*
     * WRITTEN WITHOUT A MODEL, AND THAT IS THE WHOLE OF WHAT THIS APP STORES
     * ABOUT AI. Which model serves a class is the engine's decision, read at
     * the start of a run; an id kept here would be a second owner of it, and
     * it used to WIN over anything chosen on this page.
     */
    this.settings.updateAIConfig({ provider: 'crucible', crucible: { server: name } });
    void this.ai.refresh();
    // Everything below belongs to the server that answered it. A 24 GB box and
    // a 12 GB box do not have the same choices, so nothing is carried over.
    this.engine.set(null);
    this.capability.set(null);
    this.catalog.set([]);
    this.fieldRefusals.set({});
    this.panelRefusal.set(null);
    void this.reload();
  }

  async reload(): Promise<void> {
    const name = this.server();
    if (name === '') return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [settings, capability, catalog] = await Promise.all([
        this.electron.crucible.engineSettings(name),
        this.electron.crucible.capability(name),
        this.electron.crucible.catalog(name),
      ]);
      // The page is drawn from all three, so ONE of them failing is the page
      // failing. Half a page with no note about the other half is worse than a
      // sentence saying which read did not land.
      if (!settings.success || !settings.data) {
        this.error.set(settings.error ?? name + ' would not answer for its settings.');
        return;
      }
      if (!capability.success || !capability.data) {
        this.error.set(capability.error ?? name + ' would not say what it can run.');
        return;
      }
      if (!catalog.success || !catalog.data) {
        this.error.set(catalog.error ?? name + ' would not list what it can hold.');
        return;
      }
      if (name !== this.server()) return;   // Somebody picked another one meanwhile.
      this.engine.set(settings.data);
      this.capability.set(capability.data);
      this.catalog.set(catalog.data.rows);
    } finally {
      this.loading.set(false);
    }
  }

  // -- Words ----------------------------------------------------------------

  serverSub(name: string): string {
    if (name !== this.server()) return 'not selected';
    const doc = this.engine();
    const record = this.capability();
    if (doc === null || record === null) return 'reading…';
    // Either fact may be unstated (Crucible 1.0.25) and is said to be.
    const backend = doc.backendKind === null ? 'backend not stated' : doc.backendKind;
    const card = record.totalBytes === null ? 'card size not stated' : sizeWords(record.totalBytes) + ' card';
    return backend + ' · ' + card;
  }

  actWords(act: string): string { return capabilityClassWords(act); }

  /**
   * Is this one of the four text acts?
   *
   * Only those four can be pointed at an upstream account (PHASE15 §3.3:
   * *"every non-llm class answers local"*), so only those four can have a
   * route chip. Reading a route for `pages` or `tts` would be reading a field
   * the contract says is always the same value.
   */
  isAct(cls: string): cls is CrucibleTextActName {
    return (CRUCIBLE_TEXT_ACT_NAMES as readonly string[]).includes(cls);
  }

  /** The upstream this act is pointed at, or null when it runs on the card. */
  upstreamFor(act: string): string | null {
    if (!this.isAct(act)) return null;
    const row = this.engine()?.routes[act];
    if (row === undefined || row.route !== 'upstream') return null;
    return upstreamRouteWords(row.model ?? '');
  }

  choicesFor(act: string): readonly CrucibleLocalModelChoice[] {
    return this.engine()?.localModels?.choices[act] ?? [];
  }

  selectedFor(act: string): string | null {
    const doc = this.engine();
    if (doc === null || doc.localModels === null) return null;
    return doc.localModels.selected[act] ?? null;
  }

  /** What Automatic would pick right now — the capability record's own answer. */
  automaticWords(act: string): string {
    const row = this.capability()?.classes.find((entry) => entry.capability === act);
    if (row === undefined) return 'let the engine decide';
    if (!row.enabled) return 'the engine has nothing that fits';
    return 'the engine decides — today, ' + this.modelLabel(act, row.selected);
  }

  choiceWords(choice: CrucibleLocalModelChoice): string {
    // An unstated install or fit claims nothing either way (Crucible 1.0.25).
    const size = sizeWords(choice.memoryBytesEstimate);
    if (choice.installed === false) return size + ' · not downloaded yet';
    return choice.fits === false ? size + ' · may not fit this card' : size;
  }

  rowWords(row: CrucibleCatalogRow): string {
    // A server that did not name the source says so rather than showing a blank.
    const repo = row.source === null ? 'source not stated'
      : row.source.startsWith('hf:') ? row.source.slice(3) : row.source;
    const size = row.installed ? sizeWords(row.installedBytes) : sizeWords(row.expectedBytes);
    return repo + ' · ' + size;
  }

  /*
   * `moreWords` AND `voicesMoreWords` ARE GONE (2026-09-17), with the two
   * "N more ... this engine can download" buttons they labelled. Both lists
   * are now single lists in which a thing you have not got is a row whose
   * action is Download, so there is no second list to count and no button to
   * name.
   */

  pullWords(task: CrucibleModuleProgress): string {
    if (task.state === 'failed') return task.error?.message ?? 'The download failed.';
    if (task.state === 'cancelled') return 'The download was cancelled.';
    if (task.state === 'done') return 'Downloaded. It is on the engine now.';
    if (task.bytes !== null) return bytesWords(task.bytes.done, task.bytes.total);
    if (task.line !== null) return task.line;
    return 'Starting…';
  }

  /**
   * The engine's sentence about ONE control, by its own dotted field path.
   *
   * Matched by prefix, because the server names a leaf the panel does not draw:
   * a bad key is `upstreams.anthropic.key` and the card is `upstreams.anthropic`.
   * Without the prefix the sentence would land nowhere and the person would see
   * a control that did nothing.
   */
  fieldRefusal(path: string): { code: string; message: string } | null {
    const all = this.fieldRefusals();
    const exact = all[path];
    if (exact !== undefined) return exact;
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(path + '.')) return value;
    }
    return null;
  }

  key(row: CrucibleCatalogRow): string { return row.kind + ':' + row.id; }

  /**
   * The frames of this row's pull, or null.
   *
   * A FINISHED PULL KEEPS ITS SENTENCE until the catalog is re-read, which is
   * what moves the row out of the download list and into the installed one.
   * Clearing it on the terminal frame would blank the line at the exact moment
   * it says the thing a person was waiting for.
   */
  pullOf(row: CrucibleCatalogRow): CrucibleModuleProgress | null {
    return this.pulls()[this.key(row)] ?? null;
  }

  /**
   * The models this engine could download FOR THIS CLASS, and does not have.
   *
   * THE ENGINE'S OWN LIST, not a filter this app invented over the catalog.
   * `local_model_choices` already names every candidate for a class INCLUDING
   * the ones that are not installed — measured on Owen's engine, 2026-09-17:
   * `translate` offers `qwen3.8-27b` at `installed: false`, which is exactly
   * the model he asked to be able to download for it.
   *
   * The first draft filtered the catalog instead — every `model` row that was
   * not installed — and on real data that offered `faster-whisper-tiny` under
   * "translating". The catalog is the whole backend's stock, transcribers and
   * aligners included; which of it can serve a CLASS is a question the engine
   * answers and no app should be answering twice (ARCHITECTURE.md R1).
   *
   * The catalog is still read, for the two facts `choices` does not carry: the
   * subject KIND a pull needs, and where the bytes come from.
   */
  downloadableFor(act: string): readonly CrucibleCatalogRow[] {
    const rows: CrucibleCatalogRow[] = [];
    for (const choice of this.choicesFor(act)) {
      // Only a choice the engine SAYS is not installed is offered as a download;
      // one whose install state it did not state (Crucible 1.0.25) is offered
      // for use, and the engine answers a load of it by name either way.
      if (choice.installed !== false) continue;
      const row = this.rowFor(act, choice.id);
      // NOT SKIPPED QUIETLY when the catalog does not have it. A candidate the
      // catalog cannot name has no `kind`, so there is no pull to offer; the
      // engine and its own catalog disagreeing is worth seeing rather than
      // silently drawing one row fewer.
      if (row === null) {
        /*
         * SAID ONCE PER SUBJECT, not once per frame. This function is reached
         * from the template, so an unconditional log here repeated for as long
         * as the page was open and buried everything else in the console.
         */
        const seen = `${this.server()}:${act}:${choice.id}`;
        if (!this.reportedMissingRows.has(seen)) {
          this.reportedMissingRows.add(seen);
          console.error(
            `Crucible "${this.server()}" offers "${choice.id}" for ${act} but its catalog has no `
            + 'row for it, so there is nothing to download. Report this against the engine.',
          );
        }
        continue;
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * The catalog row for one of a class's candidates.
   *
   * AN ID IS NOT UNIQUE ACROSS KINDS. Measured on Owen's engine: `sigma` is a
   * `voice` AND an `rvc` subject, two different sets of weights with one name.
   * A pull takes `kind` and `id` together, so picking the wrong row would
   * download the wrong thing under the right name.
   *
   * What separates them is the class: for every class but the text acts and
   * `pages`, the capability class and the job type are the same word (`tts`,
   * `asr`, `align`, `rvc`, `denoise`), which is the engine's own naming and not
   * a table invented here. Where an id IS unique there is nothing to separate.
   */
  /**
   * A MODEL'S NAME, NOT ITS ID, wherever a person reads one.
   *
   * The engine gives both and they are not interchangeable. Owen, on seeing the
   * ids: *"qwen3.8-27b / qwen3.8-27b-4bit -- how are these different? it should
   * be explicit. is the first one 8 bit?"* It is bf16; 3.8 is the Qwen version.
   * The catalog's `name` says so ("Qwen 3.8 - 27B (16-bit)") and the id never
   * can, because an id is a filename and a name is a sentence.
   *
   * Falls back to the id when the catalog has no row for it -- not as a default
   * hiding a lookup failure, but because a choice the catalog cannot name is
   * still a choice the engine offers, and showing its id beats showing nothing.
   */
  modelLabel(cls: string, id: string): string {
    return this.rowFor(cls, id)?.name ?? id;
  }

  private rowFor(cls: string, id: string): CrucibleCatalogRow | null {
    const matches = this.catalog().filter((row) => row.id === id);
    if (matches.length === 1) return matches[0];
    return matches.find((row) => row.jobType === cls) ?? null;
  }

  open(id: string): boolean { return this.expanded()[id] === true; }

  toggle(id: string): void {
    this.expanded.update((all) => ({ ...all, [id]: all[id] !== true }));
  }

  // -- Writing --------------------------------------------------------------

  /**
   * Choose the model for one class, or hand the choice back with null.
   *
   * The answer is the WHOLE settings document after the write, and that is
   * what is re-drawn -- never the patch that was sent, which would show a save
   * the server may have shaped differently. A refusal names the field, and its
   * sentence goes beside the act it is about rather than at the top of a page
   * where nobody can tell which control it refers to.
   */
  /**
   * Run this job on this engine, on this model -- or hand the model choice back.
   *
   * ONE PATCH, BOTH HALVES. Picking a model here is picking THIS ENGINE, which
   * is what makes the models and the accounts peers in one row of buttons
   * rather than two lists asking two halves of one question. For a text act
   * that means the route goes to `local` in the same request: section 3.2
   * applies a patch whole or not at all, so the model and the route cannot end
   * up disagreeing, and a class that was pointed at Anthropic comes back to the
   * card in one press instead of two.
   *
   * The non-llm classes have no route at all (every one of them answers
   * `local`), so sending one would be refused `route_not_routable` -- correctly,
   * and pointlessly. They get the model half alone.
   */
  async chooseModel(job: string, model: string | null): Promise<void> {
    if (this.isChosenModel(job, model) && this.routeIsLocal(job)) return;
    await this.write('local_models.' + job, this.isAct(job)
      ? { localModels: { [job]: model }, routes: { [job]: this.LOCAL_ROUTE } }
      : { localModels: { [job]: model } });
  }

  /**
   * EVERYTHING THIS JOB COULD RUN ON, in one ordered list.
   *
   * Automatic first, because handing the choice back is the answer most people
   * want and it is the one the engine keeps up to date by itself. Then this
   * engine's models -- installed ones offering Use, the rest offering Download,
   * in the engine's own order -- and then the accounts, which only the four
   * text acts can reach at all.
   *
   * THE DOWNLOAD LIST IS NOT A SEPARATE EXPANDER ANY MORE. It was "N more
   * models this engine can download" under its own button, which put the model
   * somebody wants one click further away than the ones they do not and made
   * the same list appear twice on the page. A model you have not got is just a
   * model whose action is Download.
   */
  optionsFor(job: string): readonly JobOption[] {
    const options: JobOption[] = [{
      key: 'auto',
      title: 'Automatic',
      detail: this.automaticWords(job),
      chosen: this.isAutomatic(job),
      action: this.isAutomatic(job) ? 'none' : 'use',
      progress: null,
      model: null,
      route: false,
      row: null,
    }];

    /*
     * READ ONCE, NOT ONCE PER CANDIDATE. This runs on every change-detection
     * pass for an open job, and `downloadableFor` walks the whole catalog and
     * reports mismatches -- calling it inside the loop was a full scan per row
     * and a repeating console error.
     */
    const missing = this.downloadableFor(job);

    for (const choice of this.choicesFor(job)) {
      // `!== false`, not truthiness: see `downloadableFor` — an unstated install
      // state is offered for use, never as a download.
      if (choice.installed !== false) {
        options.push({
          key: 'model:' + choice.id,
          title: this.modelLabel(job, choice.id),
          detail: this.choiceWords(choice),
          chosen: this.isChosenModel(job, choice.id),
          action: this.isChosenModel(job, choice.id) ? 'none' : 'use',
          progress: null,
          model: choice.id,
          route: false,
          row: null,
        });
        continue;
      }
      // Not installed: the catalog row carries the kind a pull needs and where
      // the bytes come from. A candidate the catalog cannot name is reported by
      // `downloadableFor` and left out rather than drawn with no action.
      const row = missing.find((entry) => entry.id === choice.id);
      if (row === undefined) continue;
      const task = this.pulls()[this.key(row)];
      options.push({
        key: 'get:' + choice.id,
        title: row.name ?? choice.id,
        detail: this.rowWords(row),
        chosen: false,
        action: 'download',
        progress: task === undefined ? null : this.pullWords(task),
        model: null,
        route: false,
        row,
      });
    }

    if (this.isAct(job)) {
      for (const id of this.upstreamModelChoices()) {
        options.push({
          key: 'route:' + id,
          title: this.upstreamRouteLabel(id),
          detail: 'an account, not this engine',
          chosen: this.routeValue(job as CrucibleTextActName) === id,
          action: this.routeValue(job as CrucibleTextActName) === id ? 'none' : 'use',
          progress: null,
          model: id,
          route: true,
          row: null,
        });
      }
    }
    return options;
  }

  /**
   * ONE PRESS DOES WHATEVER THAT CHIP MEANS.
   *
   * A chip for a model this engine has applies it; a chip for one it has not
   * downloads it. That is deliberately not two controls: the question a person
   * is answering is "run it on this one", and whether the weights happen to be
   * on the disk yet is the machine's problem, not a second decision. What keeps
   * it honest is that the chip SAYS which it is before the press -- dashed, with
   * a down-arrow -- rather than surprising somebody with a 20 GB download.
   */
  async pickOption(job: string, option: JobOption): Promise<void> {
    if (option.action === 'download') {
      await this.downloadOption(option);
      return;
    }
    if (option.action === 'none') return;
    await this.useOption(job, option);
  }

  /** The size, or the reason, as a tooltip. Off the row to keep chips one line. */
  chipTitle(option: JobOption): string {
    return option.action === 'download'
      ? 'Not on this engine yet — ' + option.detail
      : option.detail;
  }

  /**
   * A download in flight for THIS job, as one line under the row.
   *
   * On the row rather than on the chip, because a chip that grew a byte count
   * would resize and shuffle every chip beside it while it ran.
   */
  jobProgress(job: string): string | null {
    for (const option of this.optionsFor(job)) {
      if (option.progress !== null) return option.title + ': ' + option.progress;
    }
    return null;
  }

  /** Apply one option: a local model (and the route home), or an account. */
  async useOption(job: string, option: JobOption): Promise<void> {
    if (option.route) {
      await this.chooseRoute(job as CrucibleTextActName, option.model as string);
      return;
    }
    await this.chooseModel(job, option.model);
  }

  async downloadOption(option: JobOption): Promise<void> {
    if (option.row === null) return;
    await this.download(option.row);
  }

  /**
   * The one line under a job's name: what it runs on, in the engine's words.
   *
   * `jobNow` is the capability record's answer and is the honest one; this adds
   * only the sentence around it, and says plainly when nobody has said.
   */
  jobSummary(job: string): string {
    const now = this.jobNow(job);
    if (now === null) return 'This engine has not said what runs this.';
    if (this.isAct(job) && !this.routeIsLocal(job)) return 'Runs on ' + now;
    return this.isAutomatic(job) ? now + ' (chosen by the engine)' : now;
  }

  /** Is this the model the engine is set to use, AND is the job running here? */
  isChosenModel(job: string, id: string | null): boolean {
    return this.selectedFor(job) === id && this.routeIsLocal(job);
  }

  /** Automatic: no model named, and not pointed at an account. */
  isAutomatic(job: string): boolean {
    return this.selectedFor(job) === null && this.routeIsLocal(job);
  }

  private routeIsLocal(job: string): boolean {
    if (!this.isAct(job)) return true;   // every non-llm class answers `local`.
    return this.routeValue(job as CrucibleTextActName) === this.LOCAL_ROUTE;
  }

  /**
   * WHAT THIS JOB IS DOING RIGHT NOW, in the engine's own words.
   *
   * Read off the capability record rather than composed here, because that
   * record is what a run resolves through: the chip and the job agree by
   * construction. A class the record does not mention gets no chip at all,
   * which is the truth -- nobody said -- rather than a blank that reads as
   * "nothing".
   */
  jobNow(job: string): string | null {
    const row = this.capability()?.classes.find((entry) => entry.capability === job);
    if (row === undefined) return null;
    if (!row.enabled) return reasonWords(row.reason);
    if (row.route === 'upstream') return upstreamRouteWords(row.selected);
    return row.selected === '' ? null : this.modelLabel(job, row.selected);
  }

  // -- Where each job runs ---------------------------------------------------

  /** The engine's own sentence about where this act runs TODAY. */
  runsOnNow(act: CrucibleTextActName): string {
    return routeWords(this.capability(), act) ?? capabilityWords(this.capability(), act);
  }

  /** `this engine - qwen3.5-9b`, or `this engine - nothing on it fits`. */
  localOptionFor(act: CrucibleTextActName): string {
    const doc = this.engine();
    /*
     * NO DOCUMENT IS NOT "NOTHING FITS". `localRouteWords(null)` says *"this
     * engine - nothing on it fits"*, which is a measured verdict; saying it
     * about an engine that has not been read would tell somebody their card is
     * too small because their Mac was asleep.
     */
    if (doc === null) return 'this engine';
    const row = doc.routes[act];
    /*
     * The local model for a class CURRENTLY routed upstream is not in the
     * document -- section 3.1 puts the selected local model on a `local` row
     * only -- so the honest answer there is "nothing said", not a guess.
     */
    return row.route === 'local' ? localRouteWords(row) : localRouteWords(null);
  }

  upstreamRouteLabel(id: string): string { return upstreamRouteWords(id); }

  /**
   * EVERY UPSTREAM MODEL ID THIS PANEL CAN OFFER, and where each came from.
   *
   * Two sources, both facts rather than a catalog: the ids the document's own
   * routes already name (so routing a second class to the model a first one
   * uses needs no typing), and the ids a Test got back from the account itself.
   * There is no third source, because a third source would be this app shipping
   * a list of somebody else's models -- which goes stale and which
   * `tools/test-no-cloud-doors.js` forbids by name.
   */
  upstreamModelChoices(): string[] {
    const ids = new Set<string>();
    const doc = this.engine();
    if (doc !== null) {
      for (const act of this.ACTS) {
        const row = doc.routes[act];
        if (row.route === 'upstream' && row.model !== null) ids.add(row.model);
      }
    }
    for (const models of Object.values(this.testedModels())) {
      for (const id of models) ids.add(id);
    }
    return [...ids];
  }

  routeValue(act: CrucibleTextActName): string {
    const doc = this.engine();
    if (doc === null) return this.LOCAL_ROUTE;
    const row = doc.routes[act];
    return row.route === 'upstream' && row.model !== null ? row.model : this.LOCAL_ROUTE;
  }

  /**
   * Route one class, to this engine's card or to an account's model.
   *
   * The value is the SERVER's own vocabulary either way -- `local`, or
   * `<account>/<model id>` -- and is passed through untranslated. An id the
   * account does not sell is refused `route_bad_model` and the sentence lands
   * under this act's row.
   */
  async chooseRoute(act: CrucibleTextActName, value: string): Promise<void> {
    if (this.routeValue(act) === value) return;
    await this.write('routes.' + act, { routes: { [act]: value } });
  }

  // -- The three accounts ----------------------------------------------------

  upstreamTitle(name: CrucibleUpstreamName): string { return upstreamWordsLeading(name); }

  /** `Set up - ...k3A9`, with the hint rendered exactly as the engine sent it. */
  upstreamState(name: CrucibleUpstreamName): string {
    const doc = this.engine();
    if (doc === null) return '';
    return upstreamStateWords(name, doc.upstreams[name]);
  }

  isConfigured(name: CrucibleUpstreamName): boolean {
    return this.engine()?.upstreams[name]?.configured === true;
  }

  fieldLabel(name: CrucibleUpstreamName): string { return upstreamFieldWords(name).label; }
  fieldPlaceholder(name: CrucibleUpstreamName): string { return upstreamFieldWords(name).placeholder; }

  /**
   * A key is masked while it is typed; an address is not a secret.
   *
   * WHICH of the two an account takes is {@link upstreamCredentialField}'s to
   * say, not this file's: a `name === 'ollama'` here would be this panel knowing
   * a vendor, which is the first shape of provider code coming back.
   */
  fieldType(name: CrucibleUpstreamName): string {
    return upstreamCredentialField(name) === 'url' ? 'text' : 'password';
  }

  draftFor(name: CrucibleUpstreamName): string { return this.upstreamDrafts()[name] ?? ''; }

  setDraft(name: CrucibleUpstreamName, value: string): void {
    this.upstreamDrafts.update((map) => ({ ...map, [name]: value }));
  }

  testedWordsFor(name: CrucibleUpstreamName): string | null {
    const models = this.testedModels()[name];
    return models === undefined ? null : upstreamTestedWords(name, models);
  }

  /** An empty draft is an EMPTY PROBE: "test what is already configured". */
  private probeFor(name: CrucibleUpstreamName): CrucibleUpstreamProbe {
    const typed = this.draftFor(name).trim();
    if (typed.length === 0) return {};
    return upstreamCredentialField(name) === 'url' ? { url: typed } : { key: typed };
  }

  /**
   * TEST, WHICH STORES NOTHING.
   *
   * The probe crosses to the engine, the engine calls the account with it, and
   * the account's own model listing comes back. Nothing is written on the way,
   * which is what makes Test-before-Save a fact rather than a label.
   */
  async testUpstreamAccount(name: CrucibleUpstreamName): Promise<void> {
    const server = this.server();
    if (server === '' || this.engineBusy() !== null) return;
    this.engineBusy.set('upstreams.' + name);
    try {
      const res = await this.electron.crucible.testUpstream(server, name, this.probeFor(name));
      if (server !== this.server()) return;
      if (!res.success || !res.data) { this.placeRefusal(res.refusal, res.error); return; }
      if (!res.data.ok) {
        // The ACCOUNT's own no -- a rejected key, an address nothing answers at.
        // It belongs beside the field, and the engine says which field.
        this.placeRefusal(res.data.refusal, undefined);
        return;
      }
      this.clearRefusalsUnder('upstreams.' + name);
      // NARROWED, NOT ASSERTED. `CrucibleUpstreamTestResult` is a union and
      // `models` is on the `ok: true` arm only; a non-null assertion here would
      // compile and then read `undefined` the day the arms change shape.
      const found = res.data;
      this.testedModels.update((map) => ({ ...map, [name]: [...found.models] }));
    } finally {
      this.engineBusy.set(null);
    }
  }

  /** Save: one PUT that configures this account and changes no route. */
  async saveUpstream(name: CrucibleUpstreamName): Promise<void> {
    const typed = this.draftFor(name).trim();
    if (typed.length === 0) return;
    await this.write('upstreams.' + name, {
      upstreams: { [name]: this.probeFor(name) as { key: string } | { url: string } },
    });
  }

  /**
   * Remove: `null` for that account, which the engine refuses with
   * `upstream_in_use` while a route still names it -- and NAMES the classes, so
   * the fix is on the screen rather than in a manual.
   */
  async removeUpstream(name: CrucibleUpstreamName): Promise<void> {
    await this.write('upstreams.' + name, { upstreams: { [name]: null } });
  }

  // -- The one write ---------------------------------------------------------

  /**
   * EVERY CONTROL ON THIS PAGE ENDS HERE.
   *
   * One door means one set of rules, applied the same way whichever button was
   * pressed: the answer is the WHOLE document after the write and that is what
   * is re-drawn -- never the patch that was sent, which would show a save the
   * server may have shaped differently -- the credential drafts are cleared,
   * and the capability record is re-read because routing or re-modelling a
   * class changes what every other row's sentence says.
   */
  private async write(field: string, patch: CrucibleEngineSettingsPatch): Promise<void> {
    const name = this.server();
    if (name === '' || this.engineBusy() !== null) return;
    this.engineBusy.set(field);
    this.clearRefusalsUnder(field);
    try {
      const res = await this.electron.crucible.writeEngineSettings(name, patch);
      if (name !== this.server()) return;
      if (!res.success || !res.data) { this.placeRefusal(res.refusal, res.error); return; }
      this.redraw(res.data);
      const record = await this.electron.crucible.capability(name);
      if (record.success && record.data && name === this.server()) {
        this.capability.set(record.data);
      }
    } finally {
      this.engineBusy.set(null);
    }
  }

  /**
   * THE ONE DRAW. Every path onto the screen goes through here, which is what
   * makes "the key box is empty on every draw" a property of the code rather
   * than a discipline: there is nowhere else to put a document.
   */
  private redraw(doc: CrucibleEngineSettings | null): void {
    this.engine.set(doc);
    this.panelRefusal.set(null);
    this.fieldRefusals.set({});
    this.upstreamDrafts.set({});
  }

  private clearRefusalsUnder(field: string): void {
    this.fieldRefusals.update((map) => {
      const next: Record<string, { code: string; message: string }> = {};
      for (const [key, value] of Object.entries(map)) {
        if (key !== field && !key.startsWith(field + '.')) next[key] = value;
      }
      return next;
    });
    this.panelRefusal.set(null);
  }

  /**
   * A refusal, filed under the field the ENGINE named, or at the top when it
   * named none. A refusal with no field genuinely belongs nowhere in
   * particular; putting it beside a guessed control would be worse than putting
   * it where a person can at least read it.
   */
  private placeRefusal(refusal: CrucibleEngineSettingsRefusal | undefined, error?: string): void {
    if (refusal === undefined) {
      this.panelRefusal.set({
        code: 'unnamed',
        message: error ?? 'The engine could not be reached, and nothing said why.',
        field: null,
        classes: null,
      });
      return;
    }
    if (refusal.field === null) { this.panelRefusal.set(refusal); return; }
    this.fieldRefusals.update((map) => ({
      ...map,
      [refusal.field as string]: { code: refusal.code, message: refusal.message },
    }));
  }

  /** Download one subject onto the selected server. */
  async download(row: CrucibleCatalogRow): Promise<void> {
    const name = this.server();
    if (name === '') return;
    const kind: CrucibleSubjectKind = row.kind;
    const res = await this.electron.crucible.pull(name, kind, row.id);
    if (!res.success) {
      this.pulls.update((all) => ({
        ...all,
        [this.key(row)]: {
          server: name, taskId: null, state: 'failed', step: null, line: null, bytes: null,
          skipped: null, jobTypes: null, unmet: null,
          error: { code: res.code ?? 'pull_failed', message: res.error ?? 'The download failed.' },
        },
      }));
      return;
    }
    // The weights are on the engine now, so what it can choose between has
    // changed. Both documents are re-read; neither is guessed at from here.
    await this.reload();
  }

  /**
   * Remove an installed subject, behind a confirm that names the SIZE.
   *
   * crucible docs/MODEL-CHOICE.md section 7: *"behind a confirm that names the
   * SIZE -- deciding about 17.3 GB is a different decision from deciding about
   * 'a file' -- with keep as the default"*. The size comes from the server,
   * asked immediately before the question is put, rather than from the row
   * this page happens to be holding.
   */
  async remove(row: CrucibleCatalogRow): Promise<void> {
    const name = this.server();
    if (name === '' || this.removing() !== null) return;
    const prompt = await this.electron.crucible.removalPrompt(name, row.kind, row.id);
    if (!prompt.success || !prompt.data) {
      await this.dialog.alert({
        title: 'It could not be removed',
        message: prompt.error ?? name + ' would not say what removing this would delete.',
        type: 'error',
      });
      return;
    }
    const facts = prompt.data;
    const ok = await this.dialog.confirm({
      title: 'Remove ' + (facts.name ?? facts.id) + '?',
      message: 'This deletes ' + sizeWords(facts.installedBytes) + ' from ' + name + '.',
      detail: facts.resident
        ? 'It is loaded on the card right now, so anything using it stops. Downloading it again '
          + 'is the only way back.'
        : 'Downloading it again is the only way back.',
      type: 'warning',
      confirmLabel: 'Remove it',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;

    this.removing.set(this.key(row));
    try {
      const res = await this.electron.crucible.removeSubject(name, row.kind, row.id);
      if (!res.success) {
        await this.dialog.alert({
          title: 'It could not be removed',
          message: res.error ?? 'The engine refused and said nothing about why.',
          type: 'error',
        });
        return;
      }
      await this.reload();
    } finally {
      this.removing.set(null);
    }
  }
}
