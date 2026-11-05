/**
 * open-documents.words — what a row is called and drawn with: titles, sentences, icons and lineage.
 */
import { computed } from '@angular/core';
import { PRODUCES_OF } from '@owen/foundry-core/shared/host-ops';
import { languageNameFor } from '@owen/foundry-core/shared/languages';
import { mintedFromPhotographs } from '@owen/foundry-core/shared/ledger';
import { pendingStepOf } from '@owen/foundry-core/shared/pending';
import type { HostNode, Job, LedgerParams, LedgerStep, ProjectDocumentKind, ProjectSummary } from '@owen/foundry-core/shared/types';
import { type Tab } from '../../core/documents.service';
import { Lane, Row, blank } from './open-documents.model';

/**
 * ONE ROW FOR ONE THING THE HOST IS MAKING.
 *
 * Everything on it is the host's except the lineage line, which is Foundry's:
 * the host names a parent step and this composes "from **The book**" out of that
 * step's own title, in the same words every other card uses. A host writing its
 * own lineage sentence would be a second voice in a panel whose whole redesign
 * was about having one.
 *
 * THE STATE SLOT AND THE SENTENCE ARE THE SAME FIELD, spent differently. A
 * host's `detail` is a short piece of news while it is short news ("queued · 2nd
 * in line") and a sentence when it is a failure — so it goes to the right of the
 * title in the first case and onto a line of its own in the second, where there
 * is room to read it. Running, the slot shows the percentage instead, because a
 * number that changes is what the eye goes to and the message is already on the
 * progress line underneath.
 */
/**
 * One of the host's own rows.
 *
 * `parentName` IS RESOLVED BY THE CALLER RATHER THAN A STEP RESOLVED HERE, and
 * the change is Owen's third ruling arriving: a narration can now hang under an
 * EXPORT ROW, which is not a `LedgerStep` and never will be. Asking for the
 * words rather than for the record is what lets one function draw a ghost under
 * a step, under the import, and under a finished file — see `parentNameOf` for
 * the step half, which is the sentence this function used to compose itself.
 */
export function hostRow(project: ProjectSummary, node: HostNode, parentName: string | null, depth: number): Row {
  const failed = node.state === 'failed';
  const running = node.state === 'running';
  return {
    ...blank,
    key: `${project.key}:host:${node.id}`,
    kind: 'host',
    path: project.dir,
    title: node.title,
    // The parent named the same way a ledger child names it — and a node hung
    // off the IMPORT says the book's own name, because that is what the root's
    // card says and a lineage line has to point at something the reader can see.
    from: parentName,
    // A card with a lineage line does not also say what it is: the line already
    // said where it came from, and the host's own sentence rides in `state`.
    said: parentName === null ? node.detail : null,
    state: running && node.progress !== undefined
      ? `${Math.round(node.progress.percent)}%`
      : failed ? 'failed' : node.detail,
    why: failed ? node.detail : null,
    progress: running && node.progress !== undefined ? node.progress : null,
    icon: iconForHostKind(node.kind),
    tint: 'audio',
    // The four host states ARE four of the dot's six, spelled the same way on
    // purpose: the grammar in the mockup and the grammar in the contract are one
    // vocabulary, so this is a pass-through rather than a mapping table that
    // could disagree with either.
    dot: node.state,
    tooltip: `${node.title}\n${node.detail}\n`
      + 'Made by the app Foundry is running inside — it is not a step in this book’s history.',
    depth,
    dir: project.dir,
    node,
    // WHAT IT WILL PRODUCE, not what it has produced — which is exactly what
    // makes a queued node chainable: the host's next act is offered against an
    // artifact that does not exist yet.
    produces: PRODUCES_OF[node.kind],
    planned: node.state === 'queued',
    expanded: null,
  };
}

/**
 * What a ghost hung under a LEDGER row calls its parent.
 *
 * A node hung off the IMPORT says the book's own name, because that is what the
 * root's card says and a lineage line has to point at something the reader can
 * see; every other step says its own derived title. Lifted out of `hostRow` when
 * that function stopped being able to assume its parent was a step at all.
 */
export function parentNameOf(project: ProjectSummary, step: LedgerStep | null): string | null {
  if (step === null) return null;
  return step.parent === null ? project.title : titleForStep(step);
}

/**
 * THE DRAWN LINEAGE, in one backward pass over a book's finished row list.
 *
 * ── What has to be decided, per row ─────────────────────────────────────────
 *
 * Three things, and all three are questions about what comes AFTER the row: does
 * this card's own lane continue below it (a sibling, or a child's elbow to feed);
 * which ANCESTOR lanes are still running past it on their way to something of
 * their own; and is the thing any of those reach down to a plan rather than a
 * fact, which is what decides solid against dashed.
 *
 * Backwards is the only direction those are cheap in. `nextAt[d]` holds the
 * nearest row below at depth `d` that is still reachable — reachable meaning no
 * row shallower than `d` sits between, because a shallower row ENDS every lane
 * deeper than itself. Walking up, each row reads that array for its answer and
 * then rewrites it: everything deeper than this row is now cut off, and this row
 * is now the nearest thing at its own depth.
 *
 * ── Why the rows are mutated rather than rebuilt ────────────────────────────
 *
 * Every row here was built moments ago inside the same computed — six object
 * literals, none of them shared with anything and none of them escaping until
 * this returns — so a copy would be a second allocation per row to protect a
 * value nobody else has seen yet.
 */
export function drawLineage(rows: Row[]): Row[] {
  const nextAt: (Row | null)[] = [];
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at]!;
    const below = rows[at + 1] ?? null;
    const hasChild = below !== null && below.depth > row.depth;
    const sibling = nextAt[row.depth] ?? null;

    /*
     * THE ANCESTORS' LANES, outermost first. A lane is drawn where that ancestor
     * still has a sibling of its own waiting below — which is what makes a
     * translation's saves legible as being inside the translation while the
     * book's own line runs past them to the next thing made from the book.
     */
    const lanes: Lane[] = [];
    for (let level = 0; level < row.depth; level += 1) {
      const carries = nextAt[level] ?? null;
      lanes.push({
        line: carries !== null,
        dashed: carries?.planned === true,
        // The elbow belongs to the first card of an indented run and to no
        // other: every sibling after it joins the lane's own vertical instead.
        elbow: level === row.depth - 1 && (at === 0 || rows[at - 1]!.depth < row.depth),
      });
    }
    row.lanes = lanes;
    row.up = row.depth > 0 && !(lanes[row.depth - 1]?.elbow ?? false);
    /*
     * DOWN IS FED BY WHICHEVER COMES FIRST — a child's elbow hangs off this
     * card's own lane, and so does a sibling, so the segment is drawn if either
     * exists. Its dash follows the one it actually reaches: a running narration
     * with a queued assemble under it draws a dashed line down to it, which is
     * the whole "solid is what exists, dashed is the plan" grammar in one row.
     */
    const reaches = hasChild ? below : sibling;
    row.down = reaches !== null;
    row.downDashed = reaches?.planned === true;

    for (let deeper = row.depth + 1; deeper < nextAt.length; deeper += 1) nextAt[deeper] = null;
    nextAt[row.depth] = row;
  }
  return rows;
}

/**
 * Is this open document inside this project — or IS it this project?
 *
 * THE SECOND HALF IS THE BOOK TAB, and it is the one tab in this app whose path
 * is a directory rather than a file (`TabKind`, core/documents.service.ts). Every
 * other row here is a file somewhere under the project, so the prefix test with
 * the separator appended is the whole rule — and the separator is what stops
 * `Kershaw-a1b2c3d4` from claiming the documents of `Kershaw-a1b2c3d4-notes`
 * sitting beside it, which is why it cannot simply be dropped.
 */
export function inProject(filePath: string, dir: string): boolean {
  const root = fold(dir);
  const target = fold(filePath);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * WHAT THE BOOK ARRIVED AS, on the root card's second line.
 *
 * BY EXTENSION AND NOT BY NAME. The house rule forbids matching a basename
 * across directories; reading the last few characters of `archive/Book.pdf` to
 * decide between three sentences is not matching anything, and it is the only
 * fact about the original this panel needs.
 *
 * IT IS ALSO WHY THE ROOT KEEPS THE BOOK'S NAME AS ITS TITLE. The design mockup
 * put "The scan" on this card and the book's name in a header above the tree;
 * this panel has no header — the group's own ruling removed it when the import
 * root took its place — so the two facts swap slots. The name is the title,
 * because it is the one thing that must never leave the panel; what it arrived
 * as is the sentence underneath.
 */
export function arrivalSentence(origin: LedgerStep): string {
  /*
   * A CAPTURED PROJECT STARTED FROM PHOTOGRAPHS, and its root step says so —
   * the payload is the recipe, and calling it "the scan" put the scan at the
   * head of a lineage it actually sits in the MIDDLE of (the mint's card, one
   * row down, is the scan). Part of Owen's 2026-08-23 deceptive-tree ruling,
   * beside `healReadParents`.
   */
  if (origin.action === 'capture') return 'the photographs it all started from';
  const ext = extensionOf(origin.payload);
  if (ext === 'epub') return 'the book it all started from';
  if (ext === 'txt') return 'the text it all started from';
  return 'the scan it all started from';
}

export function iconForArrival(payload: string): string {
  const ext = extensionOf(payload);
  return ext === 'epub' ? 'ft-book' : ext === 'txt' ? 'ft-page' : 'ft-scan';
}

export function extensionOf(payload: string): string {
  const dot = payload.lastIndexOf('.');
  return dot < 0 ? '' : payload.slice(dot + 1).toLowerCase();
}

export function iconForTab(tab: Tab): string {
  // The book wears the reading's own mark, because the book IS the reading — the
  // same symbol `iconForStep` gives the card that opens it.
  // A light table is neither a book nor a page: it is the photographs before
  // either exists, and drawing it as a page would announce it as a document the
  // reader went and opened by hand.
  if (tab.kind === 'capture') return 'ft-capture';
  // A `pages` KIND had its own arm here (Wave 41's gravestone) wearing the
  // SCAN's mark, because a minted book was a folder of rectified pages with
  // nothing read out of them yet. A mint writes a PDF, so a minted book is a
  // `pdf` tab and takes the page mark below with every other document.
  return tab.kind === 'book' ? 'ft-book' : 'ft-page';
}

/**
 * WHAT A STEP LOOKS LIKE — the action, at a glance.
 *
 * The reading wears the book's own mark because the reading IS the book; a save
 * wears the pen this app uses everywhere for "edited"; a translation wears the
 * globe and a rewrite the spark, which is the same pair the "from here" footer
 * puts on Translate and Simplify, so the button and the card it makes are
 * recognisably one act. Nothing here is load-bearing: the title beside it says
 * the same thing in words, and the icon is what makes a tree of twenty cards
 * scannable.
 */
export function iconForStep(step: LedgerStep): string {
  if (step.action === 'read') return 'ft-book';
  if (step.action === 'curate' || step.action === 'edit') return 'ft-pen';
  /*
   * THE THREE TEXT PASSES WEAR THREE MARKS, and they are the marks their own
   * buttons wear — the globe, the spark and the wave — so a card and the button
   * that made it are recognisably one act. This line used to ask a translate row
   * whether it carried a `rewrite`, which was the ledger's old way of saying
   * "simplify"; it asks the action now, because the action says so (Owen,
   * 2026-09-05).
   */
  if (step.action === 'translate') return 'ft-globe';
  if (step.action === 'simplify') return 'ft-spark';
  if (step.action === 'clean') return 'ft-wave';
  if (step.action === 'metadata') return 'ft-tag';
  /*
   * AN ANALYSIS WEARS THE MAGNIFIER, which is the one mark on this sheet that
   * means what it looks like it means. It needs a line at all for the reason
   * every branch in this function needs one: the fall-through below is the SCAN,
   * and a report drawn as a photographed page would be the tree saying the wrong
   * thing about the one row in it that is not a state of the book.
   */
  if (step.action === 'analysis') return 'ft-glass';
  return 'ft-scan';
}

/** The host's acts, and the marks they wear on cards and on buttons alike. */
export function iconForHostKind(kind: HostNode['kind']): string {
  if (kind === 'narrate') return 'ft-mic';
  if (kind === 'enhance') return 'ft-wave';
  if (kind === 'guide') return 'ft-tag';
  return 'ft-disc';
}

/**
 * WHAT HAPPENED, AS A SENTENCE — the card's title.
 *
 * ── Derived here, and the stored label left exactly where it is ─────────────
 *
 * `LedgerStep.label` is what this app called the act at the moment it happened,
 * and `labelFor` refuses to rewrite one afterwards for a reason that has not
 * changed: *"rewriting a person's history to tidy the app's own naming would be
 * editing the record of what happened to their book"*. So nothing here touches
 * it — the tooltip still says it, verbatim, and a project that has been through
 * three of this app's vocabularies still holds three spellings.
 *
 * What a CARD needs is a different thing: a sentence a person recognises as the
 * act they ordered. "Translated (de)" is a notation — correct, and unreadable to
 * anybody who has not learned that `de` is German. So the card composes from the
 * two things the step already carries, its `action` and its `params`, and every
 * word of it is honest to what was recorded: the language name is the one the
 * dialog itself offered (`languageNameFor`, the same table `LANGUAGE_CHOICES`
 * is built from), and the rewrite phrase is the one the Simplify dialog printed
 * over the card that was pressed.
 *
 * A PARAM NOBODY WROTE DOWN SHORTENS THE SENTENCE RATHER THAN INVENTING ONE. An
 * old translation with no `language` says "Translated", because that is all the
 * ledger knows and a guess would be this panel making something up about a book.
 */
export function titleForStep(step: LedgerStep): string {
  switch (step.action) {
    case 'import':
      /*
       * A MINT IS AN IMPORT AND IS NOT "The original", which is a card this tree
       * drew for two waves and which sent Owen looking for his book somewhere
       * else. A minted step's action is `import` on purpose — seven sites branch
       * on it and every one is right that way (`mintedStep`, shared/ledger.ts) —
       * but the WORDS on the card are not one of those seven.
       *
       * "The scan" AND NOT "The pages", which this card said for one day of
       * Wave 41's afterlife. "The pages" was true when a mint wrote loose page
       * images; the mint writes a PDF now, pressing this card opens that PDF —
       * the rule every title on this tree keeps — and the reading hangs off
       * this very card BECAUSE it read that PDF. Owen caught what the old word
       * did to the lineage (2026-08-23): *"the work tree is deceptive. it
       * shows it was derived from the images."* The photographs already have
       * their own card, the root; this one is the scan this app minted out of
       * them.
       */
      return mintedFromPhotographs(step) ? 'The scan' : 'The original';
    /*
     * A NOUN, on the same precedent as "The original" and "The book": what a
     * person wants off this card is the artifact, not the act. Standing here is
     * standing on the photographs — there is no document in this project until a
     * mint makes one.
     *
     * AND WITHOUT IT THE `default` BELOW CALLS THIS CARD "Translated".
     */
    case 'capture':
      return 'The photographs';
    /*
     * THE READING IS THE BOOK, which is the ruling this title has always kept:
     * *"we shouldnt call the working files 'epub' until we export"* — the thing
     * a reading makes is the Book, and standing on this card is what opens it.
     * It is a noun where the others are past tenses, on the mockup's own
     * precedent ("The scan"), because what a person wants from this card is the
     * artifact and not the act.
     */
    case 'read':
      return 'The book';
    case 'curate':
    case 'edit':
      return 'Applied changes';
    case 'metadata':
      return metadataSentence(step.params);
    /*
     * A NOUN, "The scan"'s precedent again: what a person wants off this card
     * is the report drawn beside their book, and pressing it does exactly that
     * (`pickRow`). And WITHOUT this case the `default` below calls the card
     * "Translated" — the third table to fall into the exact trap the `capture`
     * comment above warns about, and the second action to actually fall in it
     * (Owen, 2026-08-25: *"it came out as 'translated' rather than
     * analysis"*). The default stays a default because translate params
     * genuinely vary; every action that is not a translation must say so here.
     */
    case 'analysis':
      return 'The analysis';
    /*
     * THE FOURTH ACTION TO FALL INTO THE TRAP THE `capture` COMMENT WARNS ABOUT,
     * and the third to actually fall in. Wave 55 split the text passes into
     * three actions and taught the ledger's own label ("Cleaned for narration")
     * but not this card, so a cleanup drew as "Translated" — Owen, 2026-09-05:
     * *"is an error, and its deceptive."* A simplify still reaches the default
     * on purpose: it carries `rewrite`, and `translateSentence` says which one.
     */
    case 'clean':
      return 'Cleaned for narration';
    /*
     * ── AND THE FIFTH, WHICH ONLY A PROMISE CAN REACH ────────────────────────
     *
     * The comment above is still right about every simplify that has LANDED: it
     * carries `rewrite`, `translateSentence` says which of the three it was, and
     * the default is where it belongs. A PROMISED one carries no params at all —
     * a pending step is built from a queue row, and the row's mode lives in a
     * sentence ("Simplify — plain terms"), which is the one thing this codebase
     * never reads a fact back out of (`pendingStepOf`, shared/pending.ts).
     *
     * So a params-less simplify would fall to the default and draw as
     * "Translated", which is the exact deception Owen named about the cleanup one
     * wave ago. It says the act instead, without the mode it cannot yet claim, and
     * gains the mode the moment the run lands and the card becomes real.
     */
    case 'simplify':
      return step.params?.rewrite === undefined ? 'Simplified' : translateSentence(step.params);
    default:
      return translateSentence(step.params);
  }
}

/**
 * WHAT A GRAYED CARD SAYS IT IS GOING TO BE — the landed card's own sentence, with
 * the one fact a promise can honestly claim read off the QUEUE ROW.
 *
 * ── The gap this closes, and why it was a gap at all ────────────────────────
 *
 * A pending step carries no `params`, deliberately and permanently: it is composed
 * into the ledger every `…InEffect` walk reads (`withPending`), and a promise that
 * recorded facts there would let those walks answer questions about a run that has
 * not happened. So Wave 56's promised cards read "Translated" and "Simplified" —
 * honest, and useless in front of three grayed rows where one is the German one.
 *
 * THE FACT IS ON THE ROW, WHICH IS WHERE THE QUEUE'S FACTS LIVE. `Job.into` is the
 * language a translation was asked for and `Job.mode` is the rewrite a simplify was
 * asked in, both copied off the request by main and neither read out of
 * `Job.title` — that is a SENTENCE, and this codebase does not read facts back out
 * of sentences (`pendingStepOf`, shared/pending.ts).
 *
 * THE WORDS ARE THE LANDED CARD'S, out of the same two tables, so the card does not
 * change its wording the instant the promise becomes a step.
 *
 * AND A ROW WITHOUT THEM FALLS BACK, which is not a corner: a host mints its own
 * rows and must copy the fields across (docs/BOOKFORGE-HANDOFF.md §8b), so a host
 * that has not re-vendored draws exactly the card Wave 56 drew rather than nothing.
 */
export function promisedTitle(node: LedgerStep, promise: Job): string {
  if (node.action === 'simplify' && promise.mode !== undefined) return REWRITTEN_AS[promise.mode];
  const into = promise.into?.trim() ?? '';
  if (node.action === 'translate' && into.length > 0) {
    return `Translated into ${languageNameFor(into)}`;
  }
  return titleForStep(node);
}

/**
 * "Translated into German", "Simplified into plain terms".
 *
 * A REWRITE NEVER NAMES A LANGUAGE, and that is the shape of the act rather than
 * a shortening: it happens IN the book's own language, so both ends are the same
 * tag and "Simplified into plain terms (de)" would spend the card's one line on
 * the half of the sentence that is not the answer. Which of the three modes it
 * was IS the answer, and it is what the row says. (A project holding a German
 * rewrite and an English one tells them apart by the branch they hang on, which
 * is the thing the drawn lineage now makes visible.)
 */
export function translateSentence(params: LedgerParams | undefined): string {
  const rewrite = params?.rewrite;
  if (rewrite !== undefined) return REWRITTEN_AS[rewrite];
  const into = params?.language ?? '';
  return into.length === 0 ? 'Translated' : `Translated into ${languageNameFor(into)}`;
}

/**
 * The three rewrites, as sentences.
 *
 * THE SAME WORDS THE DIALOG PRINTED. `REWRITE_LABELS` (shared/ledger.ts) holds
 * "plain terms", "natural voice" and "easy language" — the reader's phrases,
 * chosen once so that a row is recognisable as the card somebody pressed — and
 * these are those phrases with a verb in front. Two tables rather than one
 * composed string because "Simplified into natural voice" is not English and the
 * middle one has to say it differently.
 */
export const REWRITTEN_AS: Readonly<Record<NonNullable<LedgerParams['rewrite']>, string>> = {
  dejargon: 'Simplified into plain terms',
  destiffen: 'Said again in a natural voice',
  learner: 'Rewritten in easy language',
};

/**
 * "Set the title and author" — a metadata step, in words.
 *
 * THE FIELDS AND NOT THE VALUES, which is the line `LedgerParams.fields` is
 * drawn on and this inherits without restating the argument: what was actually
 * written is the step's payload, and a card is not a place to keep a second copy
 * of it. Past a few names the list stops being scannable and the plain sentence
 * is the honest answer — the same threshold `labelFor` uses, for the same
 * reason.
 */
export function metadataSentence(params: LedgerParams | undefined): string {
  const said = params?.fields ?? [];
  if (said.length === 0 || said.length > 3) return 'Set the book’s own record';
  const printed = said.length === 1
    ? said[0]!
    : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]!}`;
  return printed.length > 34 ? 'Set the book’s own record' : `Set the ${printed}`;
}

/**
 * The extra fact in front of the lineage line: "41 edits · from **The scan**".
 *
 * ONLY WHERE THE STEP ALREADY COUNTED IT. These are `params` the run wrote down
 * for its own row's sentence and nothing else (`LedgerParams.pages`, `.ops`,
 * `.amendments`), so a step from before they were recorded simply has no prefix
 * — which is the correct outcome, and the reason none of this is derived by
 * opening a file.
 */
export function factForStep(step: LedgerStep): string | null {
  const params = step.params;
  if (step.action === 'read') {
    return params?.pages === undefined || params.pages <= 0 ? null : `${params.pages} pages`;
  }
  if (step.action === 'edit') {
    return params?.ops === undefined || params.ops <= 0 ? null : `${params.ops} edits`;
  }
  if (step.action === 'curate') {
    return params?.amendments === undefined || params.amendments <= 0
      ? null
      : `${params.amendments} changes`;
  }
  return null;
}

/**
 * THE PARENT, BY NAME — the second half of every lineage line.
 *
 * Composed from the parent STEP rather than from the row above, because the row
 * above is a fact about the drawing and the parent is a fact about the book: a
 * translation made from an edit two branches away has a row above it that is
 * neither. The one node with no step behind it is the import, whose card is the
 * book's own name — so a child of the root names the BOOK, which is exactly what
 * a person would say out loud.
 */
export function parentTitleOf(step: LedgerStep, steps: readonly LedgerStep[], bookTitle: string): string | null {
  if (step.parent === null) return null;
  const parent = steps.find((one) => one.id === step.parent) ?? null;
  if (parent === null) return null;
  return parent.parent === null ? bookTitle : titleForStep(parent);
}

/**
 * What an export IS, in the words the export modal offered it in.
 *
 * THE PRODUCT AND NOT THE FORMAT, and certainly not the file: somebody chose
 * "Facsimile PDF" in a dialog and the card that turns up afterwards has to be
 * recognisably the thing they chose. A `pdf` under `final/` is never anything
 * else in this app — a real-text reprint is a `generated/` rendering and a step's
 * document, not an export — so the word is not a guess.
 *
 * AND IT IS THE ONLY PLACE IN THIS PANEL THE WORD "EPUB" APPEARS. The working
 * document is the Book; EPUB means finished (docs/WORKBENCH.md §6c, Naming).
 */
/**
 * A PROMISED EXPORT'S JOB KIND, AS THE CATALOGUE'S OWN KIND.
 *
 * The three members are the same three strings (`ConversionKind` and
 * `ProjectDocumentKind` are spelled identically and always have been), and this
 * table exists so that the identity is asserted once rather than cast at the call
 * site: a `JobKind` also holds `read`, `mint`, `analysis` and `env-install`, none of
 * which is ever a promised export, and a cast would have claimed otherwise silently.
 * `undefined` for those is a promise the caller draws as an EPUB, which it cannot
 * be — nothing but a rendering carries `mints` at all (`mintsOf`,
 * electron/job-queue.ts).
 */
export const EXPORT_LABEL_OF: Readonly<Partial<Record<Job['kind'], ProjectDocumentKind>>> = {
  epub: 'epub',
  txt: 'txt',
  pdf: 'pdf',
};

export function exportLabel(kind: ProjectDocumentKind): string {
  if (kind === 'epub') return 'EPUB';
  if (kind === 'txt') return 'Plain text';
  return 'Facsimile PDF';
}

/**
 * What a step card says on hover — including the STORED LABEL, which is the
 * record, and the STALE REASON, which is the whole of why a dimmed card is
 * dimmed.
 *
 * A step goes stale when something it was made from was replaced under it: the
 * blocks a curation named by `(page, order)` mean different blocks after a
 * re-read, and a translation of those blocks was a translation of paragraphs
 * that have moved. It is a display state and not a deletion — the payload is
 * still a true record of what was made, so the card still opens and still
 * renders. Saying that on hover is what keeps a dimmed card from reading as a
 * broken one.
 */
export function stepTitle(step: LedgerStep, standing: string | null): string {
  const full = new Date(step.createdAt).toLocaleString();
  if (step.stale === true) {
    return `${step.label} — ${full}. What this was made from has been replaced since, so it `
      + 'describes an earlier pass over the pages. It still opens, exactly as it was recorded.';
  }
  if (step.id === standing) {
    return `${step.label} — ${full}. You are standing here: this is what the panes show and `
      + 'what the next thing you do is made from.';
  }
  return `${step.label} — ${full}. Click to stand here. Nothing after it is thrown away.`;
}

/**
 * WHEN, in as few characters as a card can spare — the Steps section's rule, for
 * the Steps section's reason, now applied to every card in the tree.
 *
 * The year is dropped for anything from this one, which is nearly everything
 * anybody looks at, and kept for the rest: two cards both reading "14 Aug" would
 * be this panel quietly claiming they happened together.
 */
export function whenOn(at: number): string {
  const on = new Date(at);
  const sameYear = on.getFullYear() === new Date().getFullYear();
  return on.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A project-relative path against its project, in the project's own separator.
 *
 * Main sends `final/<name>.epub` with forward slashes whatever the platform, and
 * a Windows path spelled half one way and half the other opens perfectly well
 * and reads like a bug in the one place it is shown — the tooltip. So the joined
 * halves are made to agree rather than left to.
 */
export function joinIn(dir: string, relative: string): string {
  return dir.includes('\\')
    ? `${dir.replace(/[\\/]+$/, '')}\\${relative.replace(/\//g, '\\')}`
    : `${dir.replace(/\/+$/, '')}/${relative}`;
}

/** One spelling for a path, so Windows' three become one. */
export function fold(target: string): string {
  return target.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}
