/**
 * THE PRONUNCIATION GUIDE — BookForge's own window over ONE STEP's guide, modal over
 * Foundry's (`#/pronunciation?project=<dir>&at=<step>`, Foundry's one "Pronunciation
 * guide" tile). Owen, 2026-10-03: *"glossary should be a modal. within the modal you
 * can view the options or have it run a new job"* — so it shows the guide, and it is
 * where a guide is queued: the first one, or a REBUILD.
 *
 * ── WHAT THE WINDOW SHOWS: WHAT IS PRINTED, AND WHAT IS SAID (2026-10-31) ──
 *
 * Owen: *"the pronunciation guide's logic and ui dont really make much sense to
 * me"*, then *"maybe the ui needs to be reworked rather than the logic"*. The old
 * window drew the guide's machinery — meanings, readings, spots, "left to the
 * narrator", "the cleaner" — as three layers of words for one question: how is this
 * word said here? So it is now a list of the book's words, each as printed and as
 * the narrator will say it (initials said letter by letter drawn as keys, B E F),
 * and one word's detail: for each meaning a lit box per way of saying it, and every
 * sentence it is printed in, shown as the narrator will read it. What the guide is
 * unsure of is a filter and sorts first.
 *
 * What is saved is what the next cleanup is handed (electron/pronunciation-review.ts).
 * A choice here is a person's and lasts until the guide is rebuilt.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import { DesktopButtonComponent } from '../../creamsicle-desktop/components/desktop-button/desktop-button.component';
import {
  DesktopSelectComponent, type DesktopSelectOption,
} from '../../creamsicle-desktop/components/desktop-select/desktop-select.component';
import { ElectronService } from '../../core/services/electron.service';
import {
  APPLIED_LABEL, LEFT_TO_NARRATOR_MEANING,
  type GuideReview, type GuideReviewForm, type GuideReviewFormEdit, type GuideReviewSense,
} from '@shared/pronunciation-guide';
import type { QueueSnapshot } from '@shared/queue/engine-types';

/** A spot's choice: a meaning by index, as printed here, or left to the cleanup. */
type SpotChoice = number | 'narrator' | 'cleaner';

/**
 * How one meaning is said. `none` is a meaning whose reading the guide refused and
 * nobody has decided since: its spots go to the cleanup.
 */
type Mode = 'letters' | 'printed' | 'full' | 'own' | 'none';

/** What kind of word a form is, as the list groups it. */
type Group = 'initials' | 'abbreviation' | 'numeral' | 'emphasis';

type Show = 'needs' | 'differs' | 'printed' | 'all';

/** One form as the person is editing it. */
interface FormDraft {
  id: string;
  form: GuideReviewForm;
  group: Group;
  /** The whole form said as printed, with no meanings (a guide that found nothing to say). */
  leftWhole: boolean;
  modes: Mode[];
  /** What the person typed for each meaning's "Something else". */
  own: string[];
  choices: SpotChoice[];
  /** Whether Apply writes this word into the text. */
  applied: boolean;
}

/** This step's guide work in the queue: building it, or applying it. */
interface GuideRun { kind: 'build' | 'apply'; text: string; percent: number | null; running: boolean; stepId: string }

/** One spot as the detail draws it. */
interface SpotRow {
  index: number;
  sentence: string | null;
  before: string;
  printed: string;
  after: string;
  flag: string | null;
}

/** The narrator's view of a meaning: letters said one by one, a word, or the print itself. */
interface Said { letters: string[] | null; text: string; printed: boolean; cleanup: boolean }

const GROUP_LABEL: Record<Group, string> = {
  initials: 'Initials',
  abbreviation: 'Abbreviations',
  numeral: 'Numerals',
  emphasis: 'Capitals for emphasis',
};
const GROUP_ORDER: Group[] = ['initials', 'abbreviation', 'numeral', 'emphasis'];
const GROUP_ONE: Record<Group, string> = {
  initials: 'initials',
  abbreviation: 'abbreviation',
  numeral: 'numeral',
  emphasis: 'a word in capitals',
};

/** Below this the guide's placing of a spot is shown as unsure. */
const UNSURE = 0.6;

/** Initials printed with periods ("U.S.", "a.D."), keyed without the last one; not "e.g." or "i.e.". */
function isDotted(key: string): boolean {
  return /^(\p{L}\.)+\p{L}$/u.test(key) && key !== 'e.g' && key !== 'i.e';
}

/** The letters initials are said by, in capitals — the guide's own spelling (electron/narration-glossary.ts `lettered`). */
function lettersOf(key: string): string[] {
  return [...key.replace(/[^\p{L}]/gu, '').toUpperCase()];
}

@Component({
  selector: 'app-pronunciation-review',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, DesktopButtonComponent, DesktopSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="window">
      <header class="head">
        <div class="titles">
          <h1>Pronunciation guide</h1>
          <div class="book">
            <span class="title">{{ review()?.title ?? '' }}</span>
            @if (builtOn()) { <span class="step">Built {{ builtOn() }}</span> }
          </div>
        </div>
        <div class="actions">
          @if (saved()) { <span class="saved">{{ saved() }}</span> }
          @if (review()) {
            @if (confirmingRebuild()) {
              <span class="confirm">Throw away every decision, yours too, and decide the whole book again?</span>
              <desktop-button variant="ghost" size="sm" (click)="confirmingRebuild.set(false)">Keep the guide</desktop-button>
              <desktop-button variant="danger" size="sm" (click)="build(true)" [disabled]="busy() || run() !== null">Rebuild</desktop-button>
            } @else {
              <desktop-button variant="ghost" size="sm" (click)="confirmingRebuild.set(true)" [disabled]="busy() || run() !== null">Rebuild…</desktop-button>
              <desktop-button variant="primary" size="sm" (click)="save()" [disabled]="busy() || changes() === 0">
                {{ changes() === 0 ? 'Saved' : 'Save ' + changes() + (changes() === 1 ? ' change' : ' changes') }}
              </desktop-button>
            }
          }
        </div>
      </header>

      @if (run(); as r) {
        <div class="building">
          <span class="msg">{{ r.text }}</span>
          @if (r.percent !== null) { <span class="bar"><i [style.width.%]="r.percent"></i></span> }
          @if (r.running) {
            <desktop-button variant="ghost" size="sm" (click)="stop(r.stepId)" [disabled]="busy()">Stop</desktop-button>
          }
        </div>
      }
      @if (error()) { <div class="error">{{ error() }}</div> }

      <!--
        APPLY (Owen, 2026-11-01): the guide written into the text as a step of its
        own, under this one — no model, seconds — and a word taken out of it or put
        back by applying again. Going back to the step above undoes all of it.
      -->
      @if (review(); as r) {
        @if (run() === null || run()!.kind !== 'apply') {
          <div class="apply">
            <span class="msg">
              @if (!r.landed) {
                This step is still being made. The guide can be applied once it has landed.
              } @else if (r.appliedStep === null) {
                Not applied to the text yet. Apply writes <b>{{ r.applyPlaces }} {{ r.applyPlaces === 1 ? 'place' : 'places' }}</b>
                into a new step under this one, “{{ appliedLabel }}”, with no model.
              } @else if (r.applyPending || appliedChanges() > 0) {
                <b>The applied text is older than the guide.</b> Update it to write your changes into “{{ r.appliedStep.label }}”.
              } @else {
                Applied in “{{ r.appliedStep.label }}”: {{ r.applyPlaces }} {{ r.applyPlaces === 1 ? 'place' : 'places' }}.
              }
            </span>
            @if (r.landed && (r.appliedStep === null || r.applyPending || appliedChanges() > 0)) {
              <desktop-button variant="primary" size="sm" (click)="apply()" [disabled]="busy() || run() !== null || r.applyPlaces + appliedChanges() === 0">
                {{ r.appliedStep === null ? 'Apply to the text' : 'Update the applied text' }}
              </desktop-button>
            }
          </div>
        }
      }

      @if (stale()) {
        <div class="building">
          <span class="msg">The guide changed while you had changes open.
            <button class="link" type="button" (click)="load()">Reload it</button> to see it (your unsaved changes are dropped).</span>
        </div>
      }

      @if (review()) {
        <div class="filters">
          <div class="seg" role="group" aria-label="Show">
            <button type="button" class="needs" [attr.aria-pressed]="show() === 'needs'" (click)="show.set('needs')">
              Needs a look <span class="n">{{ counts().needs }}</span></button>
            <button type="button" [attr.aria-pressed]="show() === 'differs'" (click)="show.set('differs')">
              Read differently <span class="n">{{ counts().differs }}</span></button>
            <button type="button" [attr.aria-pressed]="show() === 'printed'" (click)="show.set('printed')">
              Said as printed <span class="n">{{ counts().printed }}</span></button>
            <button type="button" [attr.aria-pressed]="show() === 'all'" (click)="show.set('all')">
              All <span class="n">{{ counts().all }}</span></button>
          </div>
          <div class="kinds" role="group" aria-label="Kind">
            @for (g of groupsPresent(); track g) {
              <button type="button" class="chip" [attr.aria-pressed]="group() === g" (click)="group.set(group() === g ? null : g)">
                {{ groupLabel(g) }}</button>
            }
          </div>
          <input class="search" type="search" placeholder="Find a word" aria-label="Find a word"
            [ngModel]="query()" (ngModelChange)="query.set($event)" />
        </div>

        <div class="body">
          <nav class="list" aria-label="Words">
            @for (section of sections(); track section.group) {
              <div class="group-label">{{ groupLabel(section.group) }}</div>
              @for (d of section.drafts; track d.id) {
                <button type="button" class="row" [attr.aria-current]="d.id === current()?.id" (click)="pick(d.id)">
                  <span class="pair">
                    <span class="printed">{{ printedOf(d) }}</span>
                    <span class="arrow" aria-hidden="true">→</span>
                    @if (rowSaid(d); as s) {
                      <ng-container *ngTemplateOutlet="said; context: { $implicit: s, tag: true }" />
                    } @else {
                      <span class="said"><span class="tag">{{ d.form.senses.length }} meanings</span></span>
                    }
                  </span>
                  <span class="meta">
                    @if (isChanged(d)) { <span class="edited">changed</span> }
                    @if (!d.applied && readsDifferently(d)) { <span class="edited off">not applied</span> }
                    @if (needsLook(d)) { <span class="dot" title="Needs a look"></span> }
                    <span class="count">{{ d.form.count }}×</span>
                  </span>
                </button>
              }
            } @empty {
              <div class="empty">
                @if (show() === 'needs' && counts().needs === 0) { Nothing needs a look. Every word the guide decided is placed. }
                @else { No word matches. Clear the search or pick another filter. }
              </div>
            }
          </nav>

          <main class="detail">
            @if (current(); as d) {
              <div class="d-head">
                <span class="d-printed">{{ printedOf(d) }}</span>
                <span class="d-sub">{{ groupOne(d.group) }} · printed <b>{{ d.form.count }} {{ d.form.count === 1 ? 'time' : 'times' }}</b>
                  @if (d.form.by === 'person') { · decided by you }
                  @if (problemsIn(d); as p) { · {{ p }} }
                </span>
                @if (readsDifferently(d)) {
                  <button type="button" class="applied-toggle" [class.off]="!d.applied" [attr.aria-pressed]="d.applied"
                    (click)="setApplied(d, !d.applied)"
                    [title]="d.applied ? 'Take this word out of the applied text' : 'Put this word back into the applied text'">
                    {{ appliedWord(d) }}</button>
                }
              </div>

              @if (d.leftWhole) {
                <p class="note">Said as printed everywhere. The guide found nothing the narrator would read differently.</p>
              } @else {
                @for (sense of d.form.senses; track $index; let i = $index) {
                  @if (sense.meaning !== leftToNarrator) {
                    <section class="meaning">
                      <div class="meaning-title">
                        {{ meaningsShown(d) > 1 ? 'Meaning ' + (i + 1) + ': ' : 'Meaning: ' }}<b>{{ sense.meaning }}</b>
                        <span class="spots-in">{{ spotsIn(d, i) }} {{ spotsIn(d, i) === 1 ? 'place' : 'places' }}</span>
                      </div>
                      <div class="options">
                        @if (d.group === 'initials') {
                          <button type="button" class="lit" [attr.aria-pressed]="d.modes[i] === 'letters'" (click)="setMode(d, i, 'letters')">
                            <span class="label">Letter by letter</span>
                            <ng-container *ngTemplateOutlet="said; context: { $implicit: lettersSaid(d) }" />
                          </button>
                          <button type="button" class="lit" [attr.aria-pressed]="d.modes[i] === 'printed'" (click)="setMode(d, i, 'printed')">
                            <span class="label">As one word</span>
                            <span class="said"><span class="plain">{{ printedOf(d) }}</span></span>
                          </button>
                        } @else {
                          @if (sense.reading !== '') {
                            <button type="button" class="lit" [attr.aria-pressed]="d.modes[i] === 'full'" (click)="setMode(d, i, 'full')">
                              <span class="label">{{ d.group === 'emphasis' ? 'As the word' : 'Say it in full' }}</span>
                              <span class="said"><span class="word">{{ sense.reading }}</span></span>
                            </button>
                          }
                          <button type="button" class="lit" [attr.aria-pressed]="d.modes[i] === 'printed'" (click)="setMode(d, i, 'printed')">
                            <span class="label">As printed</span>
                            <span class="said"><span class="plain">{{ printedOf(d) }}</span></span>
                          </button>
                        }
                        <div class="lit" role="button" tabindex="0" [attr.aria-pressed]="d.modes[i] === 'own'"
                          (click)="setMode(d, i, 'own')" (keydown.enter)="setMode(d, i, 'own')">
                          <span class="label">Something else</span>
                          <input type="text" placeholder="Type how it’s said" [attr.aria-label]="'Your own reading of ' + sense.meaning"
                            [ngModel]="d.own[i]" (ngModelChange)="setOwn(d, i, $event)" (click)="$event.stopPropagation()" />
                        </div>
                      </div>
                      @if (sense.problem && d.modes[i] === 'none') {
                        <div class="held">Not decided, so cleanup reads these in their sentence. The guide’s answer,
                          <s>“{{ sense.reading }}”</s>, was held back: {{ sense.problem }}. Pick a way to decide it.</div>
                      } @else if (sense.problem && d.group === 'initials') {
                        <div class="guide-said">The model wanted to say <s>“{{ sense.reading }}”</s>. Initials are never spelled out in words.</div>
                      }
                    </section>
                  }
                }

                @if (d.form.spots.length > 0) {
                  <div class="spots-head">
                    <h2>Where it’s printed</h2>
                    <span class="hint">{{ showPrinted() ? 'Showing the book’s text.' : 'Showing what the narrator says.' }}</span>
                    <button type="button" class="link accent" (click)="showPrinted.set(!showPrinted())">
                      {{ showPrinted() ? 'Show what’s said' : 'Show as printed' }}</button>
                  </div>
                  <ol class="spots">
                    @for (spot of spotRows(d); track spot.index) {
                      <li class="spot" [class.unsure]="spot.flag !== null">
                        <div class="sentence">
                          @if (spot.sentence === null) {
                            <em>(this place is no longer printed where the guide saw it)</em>
                          } @else {
                            {{ spot.before }}<mark [class.cleanup]="goesToCleaner(d, d.choices[spot.index]!)"
                              [attr.title]="'Printed: ' + spot.printed">{{ spotSaid(d, spot) }}</mark>{{ spot.after }}
                          }
                        </div>
                        <div class="spot-side">
                          <desktop-select size="sm" [options]="optionsFor(d)" [ngModel]="d.choices[spot.index]"
                            (ngModelChange)="setChoice(d, spot.index, $event)" ariaLabel="How this one is said" />
                          @if (spot.flag) { <span class="why">{{ spot.flag }}</span> }
                        </div>
                      </li>
                    }
                  </ol>
                }
              }
            } @else {
              <div class="empty">Pick a word to see how it’s said and where it’s printed.</div>
            }
          </main>
        </div>
      } @else if (!busy() && !error()) {
        <div class="first">
          <p>This step has no pronunciation guide yet. The guide decides how the narrator says the words this text
            prints differently from how they are written: initials, abbreviations, numerals after a name. It decides
            each one once, for every place it appears. Cleaning from this step builds one first, or build it now.</p>
          <desktop-button variant="primary" size="sm" (click)="build(false)" [disabled]="busy() || run() !== null">Build the guide</desktop-button>
        </div>
      }
    </div>

    <ng-template #said let-s let-tag="tag">
      <span class="said" [attr.aria-label]="s.letters ? 'said letter by letter: ' + s.letters.join(' ') : null">
        @if (s.cleanup) {
          <span class="cleanup">cleanup decides</span>
        } @else if (s.letters) {
          @for (l of s.letters; track $index) { <span class="key">{{ l }}</span> }
        } @else if (s.printed) {
          <span class="plain">{{ s.text }}</span>@if (tag) { <span class="tag">as printed</span> }
        } @else {
          <span class="word">{{ s.text }}</span>
        }
      </span>
    </ng-template>
  `,
  styles: [`
    :host { display: block; height: 100%; background: var(--bg-base); color: var(--text-primary); }
    .window { display: flex; flex-direction: column; height: 100%; padding: 0 20px; }

    .head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; padding: 18px 0 12px; }
    .titles { flex: 1 1 260px; min-width: 0; }
    h1 { font-size: 19px; margin: 0; font-weight: 600; }
    .book { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 3px; color: var(--text-secondary); font-size: 13px; }
    .book .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .step { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-sunken); color: var(--text-secondary); }
    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .saved { color: var(--success-text); font-size: 12px; }
    .confirm { font-size: 12px; color: var(--text-secondary); max-width: 300px; }

    .building { display: flex; align-items: center; gap: 12px; padding: 8px 12px; margin-bottom: 10px; border-radius: 8px;
      background: var(--bg-card); border: 1px solid var(--border-subtle); font-size: 13px; }
    .building .msg { flex: 1; min-width: 0; color: var(--text-secondary); }
    .bar { flex: 0 1 220px; height: 4px; border-radius: 2px; background: var(--progress-track); overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--progress-fill); transition: width .4s; }
    .apply { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; margin-bottom: 10px;
      border-radius: 8px; border: 1px solid var(--border-subtle); background: var(--bg-card); font-size: 13px; }
    .apply .msg { flex: 1 1 260px; min-width: 0; color: var(--text-secondary); line-height: 1.45; }
    .apply .msg b { color: var(--text-primary); font-weight: 600; }
    .applied-toggle { margin-left: auto; border: 1px solid color-mix(in srgb, var(--success) 45%, transparent); color: var(--success-text);
      background: none; border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 11.5px; cursor: pointer; }
    .applied-toggle.off { border-color: var(--border-strong); color: var(--text-tertiary); }
    .applied-toggle:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .edited.off { color: var(--text-tertiary); }
    .error { background: var(--error-bg); color: var(--error-text); padding: 10px 12px; border-radius: 6px; margin-bottom: 10px; font-size: 13px; }

    .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border-default); }
    .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden; background: var(--bg-card); }
    .seg button { border: 0; background: none; padding: 5px 11px; cursor: pointer; color: var(--text-secondary); font: inherit; font-size: 12.5px;
      display: inline-flex; gap: 6px; align-items: baseline; }
    .seg button + button { border-left: 1px solid var(--border-subtle); }
    .seg button[aria-pressed="true"] { background: var(--accent-subtle); color: var(--text-primary); font-weight: 600; }
    .seg .n { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .seg button.needs .n { color: var(--warning-text); font-weight: 700; }
    .kinds { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid var(--border-default); background: none; border-radius: 999px; padding: 3px 10px; cursor: pointer;
      color: var(--text-secondary); font: inherit; font-size: 12px; }
    .chip[aria-pressed="true"] { border-color: var(--border-accent); background: var(--accent-subtle); color: var(--text-primary); }
    .search { margin-left: auto; height: var(--ui-btn-height-sm); width: 180px; min-width: 0; padding: 0 10px; border-radius: 6px;
      border: 1px solid var(--border-input); background: var(--bg-input); color: var(--text-primary); font: inherit; font-size: 13px; }
    .search:focus { outline: none; box-shadow: var(--focus-ring); }

    .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); }
    .list { overflow: auto; border-right: 1px solid var(--border-default); padding: 4px 0 24px; }
    .group-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-tertiary); padding: 12px 12px 4px; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 7px 12px; border: 0; border-left: 3px solid transparent; background: none; cursor: pointer; color: inherit; font: inherit; }
    .row:hover { background: var(--hover-bg); }
    .row[aria-current="true"] { background: var(--bg-card); border-left-color: var(--accent); }
    .row:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .pair { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
    .printed { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 17px; line-height: 1.2; }
    .arrow { color: var(--text-tertiary); font-size: 12px; }
    .meta { display: flex; align-items: center; gap: 8px; }
    .count { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warning); }
    .edited { font-size: 10.5px; color: var(--text-accent); }

    /* What the voice hears: letters said one by one are keys, a word is a word, the print is the book's type. */
    .said { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 3px; font-size: 13.5px; }
    .key { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; font-weight: 600; min-width: 18px; height: 20px; padding: 0 4px;
      display: inline-grid; place-items: center; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px;
      background: var(--bg-card); color: var(--text-primary); }
    .word { font-weight: 500; }
    .plain { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 15px; color: var(--text-secondary); }
    .tag { font-size: 10.5px; color: var(--text-tertiary); margin-left: 4px; }
    .cleanup { color: var(--warning-text); font-style: italic; font-size: 12.5px; }

    .detail { overflow: auto; padding: 18px 0 40px 22px; min-width: 0; }
    .d-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
    .d-printed { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 38px; line-height: 1.05; }
    .d-sub { color: var(--text-secondary); font-size: 13px; }
    .d-sub b { color: var(--text-primary); font-weight: 600; }
    .note { color: var(--text-secondary); font-size: 13px; margin-top: 16px; }
    .meaning { margin-top: 20px; }
    .meaning-title { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
    .meaning-title b { color: var(--text-primary); font-weight: 600; }
    .spots-in { margin-left: auto; font-size: 11px; color: var(--text-tertiary); }
    .options { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
    .lit { display: flex; flex-direction: column; gap: 6px; min-height: 62px; padding: 10px 12px; text-align: left; cursor: pointer;
      border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-card); color: inherit; font: inherit; }
    .lit:hover { border-color: var(--text-tertiary); }
    .lit:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .lit[aria-pressed="true"] { border-color: var(--border-accent); background: var(--accent-subtle); box-shadow: inset 0 0 0 1px var(--border-accent); }
    .lit .label { font-size: 11.5px; color: var(--text-secondary); }
    .lit[aria-pressed="true"] .label { color: var(--text-primary); font-weight: 600; }
    .lit input { height: 26px; min-width: 0; width: 100%; padding: 0 8px; border-radius: 5px; border: 1px solid var(--border-input);
      background: var(--bg-input); color: var(--text-primary); font: inherit; font-size: 13px; }
    .lit input:focus { outline: none; box-shadow: var(--focus-ring); }
    .guide-said { margin-top: 8px; font-size: 12px; color: var(--text-tertiary); }
    .held { margin-top: 8px; font-size: 12px; color: var(--warning-text); line-height: 1.45; }
    s { color: var(--text-secondary); }

    .spots-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; margin: 26px 0 8px; }
    .spots-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
    .hint { color: var(--text-tertiary); font-size: 12px; }
    .spots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .spot { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px 12px; padding: 9px 12px;
      border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-subtle); }
    .spot.unsure { border-color: var(--warning); box-shadow: inset 3px 0 0 var(--warning); }
    .sentence { font-size: 13.5px; line-height: 1.55; color: var(--text-secondary); min-width: 0; }
    mark { background: var(--accent-subtle); color: var(--text-primary); border-radius: 4px; padding: 1px 3px; box-shadow: inset 0 -2px 0 var(--accent); }
    mark.cleanup { background: var(--warning-bg); box-shadow: inset 0 -2px 0 var(--warning); }
    .spot-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 200px; }
    .why { font-size: 11px; color: var(--warning-text); }

    .empty { color: var(--text-tertiary); font-size: 13px; padding: 24px 12px; }
    .first { max-width: 620px; color: var(--text-secondary); font-size: 13px; line-height: 1.55; margin-top: 24px; }
    .link { background: none; border: none; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
    .link.accent { color: var(--text-accent); text-decoration: none; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { .bar > i { transition: none; } }
  `],
})
export class PronunciationReviewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly leftToNarrator = LEFT_TO_NARRATOR_MEANING;
  protected readonly appliedLabel = APPLIED_LABEL;

  readonly review = signal<GuideReview | null>(null);
  readonly drafts = signal<FormDraft[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly saved = signal<string | null>(null);
  /** THIS STEP'S GUIDE RUN while it is in BookForge's queue (its card on Foundry's tree says the same). */
  readonly run = signal<GuideRun | null>(null);
  /** The guide changed on disk while there were changes here that a reload would drop. */
  readonly stale = signal(false);
  readonly confirmingRebuild = signal(false);

  readonly show = signal<Show>('all');
  readonly group = signal<Group | null>(null);
  readonly query = signal('');
  readonly showPrinted = signal(false);
  private readonly picked = signal<string | null>(null);

  /** Each draft's state as last read or saved, for "is there anything to save". */
  private readonly baseline = signal(new Map<string, string>());

  readonly builtOn = computed(() => {
    const built = this.review()?.built;
    return built ? new Date(built).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  });

  readonly counts = computed(() => {
    const all = this.drafts();
    const differs = all.filter((d) => this.readsDifferently(d)).length;
    return { all: all.length, needs: all.filter((d) => this.needsLook(d)).length, differs, printed: all.length - differs };
  });

  readonly groupsPresent = computed(() => GROUP_ORDER.filter((g) => this.drafts().some((d) => d.group === g)));

  readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const show = this.show();
    const group = this.group();
    return this.drafts().filter((d) => {
      if (show === 'needs' && !this.needsLook(d)) return false;
      if (show === 'differs' && !this.readsDifferently(d)) return false;
      if (show === 'printed' && this.readsDifferently(d)) return false;
      if (group !== null && d.group !== group) return false;
      if (q !== '' && !this.printedOf(d).toLowerCase().includes(q) && !d.form.senses.some((s) => s.meaning.toLowerCase().includes(q))) return false;
      return true;
    });
  });

  readonly sections = computed(() => GROUP_ORDER
    .map((group) => ({ group, drafts: this.visible().filter((d) => d.group === group) }))
    .filter((s) => s.drafts.length > 0));

  /** The word shown on the right: the one picked, while the filters show it; else the first shown. */
  readonly current = computed((): FormDraft | null => {
    const visible = this.visible();
    return visible.find((d) => d.id === this.picked()) ?? visible[0] ?? null;
  });

  readonly changes = computed(() => {
    const base = this.baseline();
    return this.drafts().filter((d) => base.get(d.id) !== this.snapshotOf(d)).length;
  });

  private projectDir = '';
  /** The book's step the window was opened from — what a new guide is made from. */
  private at = '';

  constructor() {
    const project = this.route.snapshot.queryParamMap.get('project');
    const at = this.route.snapshot.queryParamMap.get('at');
    if (project === null || project === '' || at === null || at === '') {
      this.error.set('This window was opened without a book step.');
      return;
    }
    this.projectDir = project;
    this.at = at;
    /*
     * A GUIDE STEP THAT FINISHES says so on `project:files-changed`; the list is
     * read again then — unless there are unsaved changes, which are not dropped
     * behind the person's back.
     */
    this.destroyRef.onDestroy(this.electron.onProjectFilesChanged((dir) => {
      if (dir !== this.projectDir) return;
      if (this.changes() > 0) { this.stale.set(true); return; }
      void this.load();
    }));
    this.destroyRef.onDestroy(this.electron.onQueueChanged((snapshot) => this.run.set(this.guideRunIn(snapshot))));
    void this.electron.listQueue().then((res) => { if (res.success && res.data) this.run.set(this.guideRunIn(res.data)); });
    void this.load();
  }

  /** This step's guide run in the queue, said in a line, or null when there is none waiting or running. */
  private guideRunIn(snapshot: QueueSnapshot): GuideRun | null {
    for (const job of snapshot.jobs) {
      for (const step of job.steps) {
        const applying = this.applyRunOf(step);
        if (applying !== null) return applying;
        if (step.type !== 'narration-guide' || step.config['projectDir'] !== this.projectDir
          || step.config['at'] !== this.at) continue;
        const over = step.config['fromZero'] === true ? 'Rebuilding the guide' : 'Building the guide';
        switch (step.status) {
          case 'running':
            return { kind: 'build', text: `${over}: ${step.progress.message ?? 'starting'}`, percent: step.progress.percent ?? null, running: true, stepId: step.id };
          case 'queued':
          case 'waiting':
            return {
              text: step.parentStepId === 'source'
                ? `${over} is queued in BookForge. This window shows the guide when it finishes.`
                : `${over} waits for this step to land, then runs. This window shows the guide when it finishes.`,
              kind: 'build', percent: null, running: false, stepId: step.id,
            };
          case 'held':
            return { kind: 'build', text: `${over} is in BookForge's queue, not started. Press Start there.`, percent: null, running: false, stepId: step.id };
          default:
            continue;
        }
      }
    }
    return null;
  }

  /** This step's Apply, when `step` is it (a readings-only pass of the guide made from this step). */
  private applyRunOf(step: QueueSnapshot['jobs'][number]['steps'][number]): GuideRun | null {
    if (step.type !== 'foundry-job') return null;
    const request = step.config['request'] as Record<string, unknown> | undefined;
    if (request === undefined || request['readingsOnly'] === undefined || request['at'] !== this.at
      || step.config['projectDir'] !== this.projectDir) return null;
    switch (step.status) {
      case 'running':
        return { kind: 'apply', text: 'Applying the guide to the text…', percent: step.progress.percent ?? null, running: true, stepId: step.id };
      case 'queued':
      case 'waiting':
        return { kind: 'apply', text: 'Applying the guide is queued in BookForge.', percent: null, running: false, stepId: step.id };
      case 'held':
        return { kind: 'apply', text: 'Applying the guide is in BookForge’s queue, not started. Press Start there.', percent: null, running: false, stepId: step.id };
      default:
        return null;
    }
  }

  /**
   * APPLY, or UPDATE THE APPLIED TEXT: unsaved changes are saved first, because
   * what Apply writes is the guide as saved.
   */
  async apply(): Promise<void> {
    if (this.changes() > 0) {
      await this.save();
      if (this.error() !== null) return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.electron.applyPronunciationGuide(this.projectDir, this.at);
      if (!res.success) { this.error.set(res.error ?? 'The guide could not be applied.'); return; }
      this.saved.set(`Applying ${res.places ?? 0} place(s) as “${APPLIED_LABEL}”`);
    } finally {
      this.busy.set(false);
    }
  }

  /** Words whose applied state is changed here and not saved yet. */
  appliedChanges(): number {
    const forms = new Map<string, GuideReviewForm>((this.review()?.forms ?? []).map((f) => [`${f.kind}\u0000${f.key}`, f] as const));
    return this.drafts().filter((d) => forms.get(d.id)?.applied !== d.applied).length;
  }

  setApplied(d: FormDraft, applied: boolean): void { this.update(d, { applied }); }

  /** The word's state in the applied text, as its toggle says it. */
  appliedWord(d: FormDraft): string {
    const was = d.form.applied;
    if (d.applied === was) return d.applied ? 'In the applied text' : 'Not in the applied text';
    return d.applied ? 'Will be put back' : 'Will be taken out';
  }

  /** Queue a guide: the first one, or a rebuild from zero. */
  async build(rebuild: boolean): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.electron.buildPronunciationGuide(this.projectDir, this.at, rebuild);
      if (!res.success) { this.error.set(res.error ?? 'The guide could not be queued.'); return; }
      this.confirmingRebuild.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  async stop(stepId: string): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.electron.cancelQueueStep(stepId, 'Stopped in the pronunciation guide');
      if (!res.success) this.error.set(res.error ?? 'The guide run could not be stopped.');
    } finally {
      this.busy.set(false);
    }
  }

  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.saved.set(null);
    this.stale.set(false);
    try {
      const res = await this.electron.readPronunciationGuide(this.projectDir, this.at);
      if (!res.success) { this.error.set(res.error ?? 'The guide could not be read.'); return; }
      const review = res.review ?? null;
      this.review.set(review);
      const drafts = review === null ? [] : this.order(review.forms.map((form) => this.draftOf(form)));
      this.drafts.set(drafts);
      this.baseline.set(new Map(drafts.map((d) => [d.id, this.snapshotOf(d)] as const)));
      // Open on what needs a look, when anything does.
      if (this.show() === 'all' && drafts.some((d) => this.needsLook(d))) this.show.set('needs');
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    const review = this.review();
    if (review === null) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const forms = this.drafts().map((d) => this.editOf(d));
      const res = await this.electron.savePronunciationGuide({ projectDir: review.projectDir, at: review.at, version: review.version, forms });
      if (!res.success) { this.error.set(res.error ?? 'Your changes could not be saved.'); return; }
      await this.load();
      this.saved.set(`Saved ${res.forms ?? 0} word(s), ${res.spots ?? 0} place(s) moved`);
    } finally {
      this.busy.set(false);
    }
  }

  pick(id: string): void { this.picked.set(id); }

  groupLabel(g: Group): string { return GROUP_LABEL[g]; }
  groupOne(g: Group): string { return GROUP_ONE[g]; }

  /** The form as the book prints it: every spelling, "a.D. · A.D.". */
  printedOf(d: FormDraft): string {
    if (d.form.kind === 'roman') return d.form.key;
    const spellings = [...new Set(d.form.spots.map((s) => s.printed))];
    return spellings.length > 0 ? spellings.slice(0, 3).join(' · ') : d.form.key;
  }

  /** What the narrator is handed for meaning `i`: '' is as printed. */
  readingOf(d: FormDraft, i: number): string {
    switch (d.modes[i]) {
      case 'letters': return lettersOf(d.form.key).join(' ');
      case 'printed': return '';
      case 'full': return d.form.senses[i]!.reading;
      case 'own': return d.own[i]!.trim();
      default: return d.form.senses[i]!.reading;
    }
  }

  lettersSaid(d: FormDraft): Said { return { letters: lettersOf(d.form.key), text: '', printed: false, cleanup: false }; }

  /** How meaning `i` sounds. */
  saidOf(d: FormDraft, i: number): Said {
    if (d.modes[i] === 'none') return { letters: null, text: '', printed: false, cleanup: true };
    if (d.modes[i] === 'letters') return this.lettersSaid(d);
    const reading = this.readingOf(d, i);
    if (reading === '') return { letters: null, text: this.printedOf(d).split(' · ')[0]!, printed: true, cleanup: false };
    return { letters: null, text: reading, printed: false, cleanup: false };
  }

  /** The list row's "said as", or null when the form's meanings are said differently. */
  rowSaid(d: FormDraft): Said | null {
    if (d.leftWhole) return { letters: null, text: this.printedOf(d).split(' · ')[0]!, printed: true, cleanup: false };
    const shown = d.form.senses.map((s, i) => ({ s, i })).filter(({ s }) => s.meaning !== LEFT_TO_NARRATOR_MEANING);
    if (shown.length === 0) return { letters: null, text: this.printedOf(d).split(' · ')[0]!, printed: true, cleanup: false };
    const all = shown.map(({ i }) => this.saidOf(d, i));
    const first = JSON.stringify(all[0]);
    return all.every((s) => JSON.stringify(s) === first) ? all[0]! : null;
  }

  meaningsShown(d: FormDraft): number {
    return d.form.senses.filter((s) => s.meaning !== LEFT_TO_NARRATOR_MEANING).length;
  }

  /** Placed nowhere, or in a meaning nobody has decided — either way the cleanup reads it in its sentence. */
  goesToCleaner(d: FormDraft, c: SpotChoice): boolean {
    return c === 'cleaner' || (typeof c === 'number' && d.modes[c] === 'none');
  }

  private unsureAt(d: FormDraft, index: number): boolean {
    const spot = d.form.spots[index]!;
    const c = d.choices[index]!;
    return typeof c === 'number' && c === spot.sense && spot.p !== null && spot.p < UNSURE;
  }

  /**
   * NEEDS A LOOK: a place of a word the guide reads differently that goes to the
   * cleanup, or one the guide placed but was unsure of. A word said as printed in
   * every meaning is said as printed wherever it falls, so its unplaced places are
   * not news (the run's own "left to their sentence" counts the same way).
   */
  needsLook(d: FormDraft): boolean {
    if (d.leftWhole) return false;
    const reads = d.form.decision === 'reading' || d.modes.some((m) => m !== 'printed');
    return d.choices.some((c, i) => (reads && this.goesToCleaner(d, c)) || this.unsureAt(d, i));
  }

  readsDifferently(d: FormDraft): boolean {
    return !d.leftWhole && d.form.senses.some((s, i) => s.meaning !== LEFT_TO_NARRATOR_MEANING && d.modes[i] !== 'none'
      && this.readingOf(d, i) !== '');
  }

  problemsIn(d: FormDraft): string {
    const toCleaner = d.choices.filter((c) => this.goesToCleaner(d, c)).length;
    const unsure = d.choices.filter((_, i) => this.unsureAt(d, i)).length;
    return [toCleaner > 0 ? `${toCleaner} for cleanup to decide` : '', unsure > 0 ? `${unsure} the guide is unsure of` : '']
      .filter(Boolean).join(', ');
  }

  spotsIn(d: FormDraft, sense: number): number {
    return d.choices.filter((c) => c === sense).length;
  }

  isChanged(d: FormDraft): boolean { return this.baseline().get(d.id) !== this.snapshotOf(d); }

  setMode(d: FormDraft, i: number, mode: Mode): void {
    const modes = [...d.modes];
    modes[i] = mode;
    this.update(d, { modes });
  }

  setOwn(d: FormDraft, i: number, value: string): void {
    const own = [...d.own];
    own[i] = value;
    const modes = [...d.modes];
    modes[i] = 'own';
    this.update(d, { own, modes });
  }

  setChoice(d: FormDraft, index: number, value: SpotChoice): void {
    const choices = [...d.choices];
    choices[index] = value;
    this.update(d, { choices });
  }

  /**
   * A PLACE'S CHOICES, NAMED BY WHAT HAPPENS (Owen, 2026-10-03: "i cant read the
   * dropdowns. what are the options?"). One meaning is "Same as the rest"; with two
   * or more, each is named. "As printed here" keeps the book's text for this place
   * alone; "Let cleanup decide" hands it to the cleanup's sentence pass.
   */
  optionsFor(d: FormDraft): DesktopSelectOption[] {
    const meanings = d.form.senses.map((s, i) => ({ s, i })).filter(({ s }) => s.meaning !== LEFT_TO_NARRATOR_MEANING);
    const options: DesktopSelectOption[] = meanings.map(({ s, i }) => ({
      value: i,
      label: meanings.length === 1 ? 'Same as the rest' : `Means ${s.meaning}`,
      title: s.meaning,
    }));
    options.push({ value: 'narrator', label: 'As printed here', title: 'The book’s text reaches the narrator untouched' });
    options.push({ value: 'cleaner', label: 'Let cleanup decide', title: 'Cleanup reads this place in its sentence and decides' });
    return options;
  }

  /** The places, cleanup's and unsure ones first, each with its sentence split around the printed form. */
  spotRows(d: FormDraft): SpotRow[] {
    const rows: SpotRow[] = d.form.spots.map((spot, index) => {
      const c = d.choices[index]!;
      const flag = c === 'cleaner' ? 'Not placed'
        : this.goesToCleaner(d, c) ? 'Not decided'
          : this.unsureAt(d, index) ? `Unsure (${Math.round(spot.p! * 100)}%)` : null;
      const sentence = spot.sentence;
      const at = sentence === null ? -1 : sentence.indexOf(spot.printed);
      return at < 0
        ? { index, sentence, before: sentence ?? '', printed: spot.printed, after: '', flag }
        : { index, sentence, before: sentence!.slice(0, at), printed: spot.printed, after: sentence!.slice(at + spot.printed.length), flag };
    });
    const rank = (r: SpotRow): number => (r.flag === null ? 1 : 0);
    return [...rows].sort((a, b) => rank(a) - rank(b));
  }

  /** What the narrator says at one place, or the print when the book's text is shown. */
  spotSaid(d: FormDraft, row: SpotRow): string {
    const c = d.choices[row.index]!;
    if (this.showPrinted() || typeof c !== 'number' || this.goesToCleaner(d, c)) return row.printed;
    const reading = this.readingOf(d, c);
    if (reading === '') return row.printed;
    // A period the reading does not consume stays, as the guide's spot replace keeps it.
    const dotted = row.printed.endsWith('.');
    const keepsPeriod = dotted && (d.modes[c] !== 'letters' && !d.form.senses[c]!.periodIsPart);
    return keepsPeriod ? `${reading}.` : reading;
  }

  private groupOf(form: GuideReviewForm): Group {
    const kinds = form.senses.map((s) => s.kind);
    if (form.kind === 'roman' || kinds.includes('numeral')) return 'numeral';
    if (form.kind === 'caps') return kinds.length > 0 && kinds.every((k) => k === 'word') ? 'emphasis' : 'initials';
    return isDotted(form.key) ? 'initials' : 'abbreviation';
  }

  private draftOf(form: GuideReviewForm): FormDraft {
    const group = this.groupOf(form);
    const letters = lettersOf(form.key).join(' ');
    const modes: Mode[] = form.senses.map((s) => {
      if (s.problem !== undefined) return 'none';
      if (s.reading === '') return 'printed';
      if (group === 'initials' && s.reading === letters) return 'letters';
      return 'full';
    });
    const narrator = form.senses.findIndex((s) => s.meaning === LEFT_TO_NARRATOR_MEANING);
    const choices: SpotChoice[] = form.spots.map((spot) => {
      if (spot.sense === null) return 'cleaner';
      return spot.sense === narrator ? 'narrator' : spot.sense;
    });
    return {
      id: `${form.kind}\u0000${form.key}`,
      form,
      group,
      leftWhole: form.decision === 'as-printed' && form.senses.length === 0,
      modes,
      own: form.senses.map(() => ''),
      choices,
      applied: form.applied,
    };
  }

  /** What needs a look first, then by how often the book prints it. */
  private order(drafts: FormDraft[]): FormDraft[] {
    return [...drafts].sort((a, b) => (this.needsLook(b) ? 1 : 0) - (this.needsLook(a) ? 1 : 0) || b.form.count - a.form.count);
  }

  private editOf(d: FormDraft): GuideReviewFormEdit {
    const base = { key: d.form.key, kind: d.form.kind, applied: d.applied };
    if (d.leftWhole) return { ...base, decision: 'as-printed', senses: [], spots: [] };
    const dotted = isDotted(d.form.key);
    const senses: GuideReviewSense[] = d.form.senses.map((s, i) => {
      if (d.modes[i] === 'none') return { ...s };
      // Letters replace a dotted form whole ("U.S." → "U S"), its periods with it.
      const periodIsPart = d.modes[i] === 'letters' ? dotted : s.periodIsPart;
      return { meaning: s.meaning, reading: this.readingOf(d, i), periodIsPart, ...(s.kind === undefined ? {} : { kind: s.kind }) };
    });
    let narrator = senses.findIndex((s) => s.meaning === LEFT_TO_NARRATOR_MEANING);
    if (narrator < 0 && d.choices.includes('narrator')) {
      senses.push({ meaning: LEFT_TO_NARRATOR_MEANING, reading: '', periodIsPart: false });
      narrator = senses.length - 1;
    }
    // The guide's own word stands unless a meaning changed; a reading given makes it one.
    const untouched = senses.length === d.form.senses.length && senses.every((s, i) => s.reading === d.form.senses[i]!.reading
      && (s.problem === undefined) === (d.form.senses[i]!.problem === undefined));
    const decision = untouched ? d.form.decision : senses.some((s) => s.reading !== '') ? 'reading' : 'as-printed';
    return {
      ...base,
      decision,
      senses,
      spots: d.form.spots.map((spot, i) => {
        const choice = d.choices[i]!;
        const sense = choice === 'cleaner' ? null : choice === 'narrator' ? narrator : choice;
        return { at: spot.at, nth: spot.nth, printed: spot.printed, sense };
      }),
    };
  }

  private snapshotOf(d: FormDraft): string {
    return JSON.stringify([d.applied, d.form.senses.map((_, i) => (d.modes[i] === 'none' ? null : this.readingOf(d, i))), d.choices]);
  }

  private update(d: FormDraft, change: Partial<FormDraft>): void {
    this.saved.set(null);
    this.drafts.update((all) => all.map((x) => (x.id === d.id ? { ...x, ...change } : x)));
  }
}
