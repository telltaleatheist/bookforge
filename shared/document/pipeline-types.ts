/**
 * The document pipeline's wire format — one declaration, two programs.
 *
 * Main reads the working document and writes it; the picker paints it and edits
 * it. Both have to agree on these shapes down to the field name, so both import
 * THEM rather than a copy of them.
 *
 * This file exists because the shape it replaces did the opposite. `FoundryRunState`,
 * `FoundryPickerBlock` and `FoundryExportRequest` were each declared three times —
 * once in `electron/foundry-run.ts`, once in `electron/preload.ts`, once in the
 * renderer's `electron.service.ts` — and nothing made them agree. Renaming a field
 * in one broke no build; it desynced an IPC payload silently. These are types and
 * nothing else, so there is no reason for a second copy to exist.
 *
 * The model they describe is in docs/DOCUMENT_PIPELINE.md.
 */

/**
 * Which pipeline a working document belongs to.
 *
 * `scanned` — the words came out of Tesseract and are repaired, line by line, by
 * the ocr model before they are reflowed. `text` — the words are the publisher's
 * and no model is pointed at them. The distinction decides whether a model edits
 * somebody's book, and the wrong answer is silent either way.
 */
export type DocumentClass = 'scanned' | 'text';

/** The stages that WRITE INTO the working document, in pipeline order. */
export const DOCUMENT_STAGES = ['get-text', 'blocks', 'footnotes'] as const;
export type DocumentStage = (typeof DOCUMENT_STAGES)[number];

/** Where a reset can land. `none` is "before Get Text" — no working document. */
export type ResetTarget = DocumentStage | 'none';

/**
 * How a caller names the documents it means: by PROJECT, never by path.
 *
 * The working document's name is derived from the original's, so a renderer
 * holding one could hold a stale one — and a window open across a re-import
 * would curate a document belonging to different bytes. `variantId` picks
 * between a project's versions when it holds more than one PDF; without it a
 * project with two is a question rather than a guess.
 */
export interface DocumentRef {
  projectDir: string;
  variantId?: string;
  sourcePath?: string;
}

/** One block, as the document carries it. */
export interface BlockAnnotation {
  id: string;
  /** 0-based page index in the working document. */
  page: number;
  /** Position in the book's reading order. Unique across the document. */
  seq: number;
  category: string;
  /** `[x0,y0,x1,y1]` in PDF user space, corners normalized low→high. */
  rect: [number, number, number, number];
  /** The block's text. For a `chapter` block this IS the chapter's title. */
  text: string;
  /** The block ids this one was merged from. Empty when it is one block. */
  merged: string[];
  /** Dropped from the book. */
  deleted: boolean;
}

export interface DocumentPage {
  /** 0-based index. */
  index: number;
  /** `[x0,y0,x1,y1]` of the page's crop box, in PDF user space. */
  cropBox: [number, number, number, number];
  /** The page was removed in the picker. */
  deleted: boolean;
}

/**
 * The block layer as the picker receives it.
 *
 * Geometry is PDF USER SPACE — points, origin bottom-left, y up — together with
 * each page's crop box. It is deliberately NOT converted to the picker's
 * top-left pixel frame on the way over: that conversion carries the crop-box
 * origin (a trimmed scanner margin is the common case, and a renderer's pixel
 * (0,0) is the crop box's corner rather than the media box's) and belongs with
 * the code that paints.
 */
export interface DocumentBlocksPayload {
  documentClass: DocumentClass;
  /** The pixel frame the geometry was measured in, from the document's marker. */
  dpi: number;
  pages: DocumentPage[];
  blocks: BlockAnnotation[];
}

/**
 * One curation edit.
 *
 * A block has ONE category field, so `relabel` is the whole of "what this block
 * is" and there is no second place for a selection or a colour to disagree with
 * it. `delete` is a FLAG rather than a removal, which is what makes `restore`
 * possible: the annotation stays, carrying its geometry and its text.
 */
export type WorkingDocumentEdit =
  | { kind: 'relabel'; blockId: string; category: string }
  | { kind: 'retitle'; blockId: string; text: string }
  | { kind: 'delete'; blockId: string }
  | { kind: 'restore'; blockId: string }
  | { kind: 'delete-page'; page: number }
  | { kind: 'restore-page'; page: number }
  | { kind: 'merge'; blockIds: string[] };

/**
 * Which stages this book's documents have been through, MEASURED off the files.
 *
 * Three of the four are answered by the document itself: a marker means Get Text
 * has run, block annotations mean Blocks has, a book on disk the binding vouches
 * for means Reflow has. Only Footnotes needs the binding, because its work is a
 * rewrite of an invisible text layer and there is nothing to count.
 */
export interface DocumentPipelineStages {
  getText: boolean;
  blocks: boolean;
  footnotes: boolean;
  reflow: boolean;
}

export interface DocumentPipelineState {
  stages: DocumentPipelineStages;
  /** Null before a working document has been cast. */
  documentClass: DocumentClass | null;
  blockCount: number;
  deletedBlockCount: number;
  /** The stages a reset can land on — those with a recorded boundary. */
  resetTargets: DocumentStage[];
  /** For diagnostics and the reset dialog's wording. Never a user-facing listing. */
  workingPath: string;
  primaryRelPath: string;
}

/** A stage's own most recent line, as it runs. */
export interface DocumentStageProgressEvent {
  projectDir: string;
  stage: string;
  /** foundry's own line, verbatim — never summarized. */
  message: string;
  done: number;
  total: number;
}
