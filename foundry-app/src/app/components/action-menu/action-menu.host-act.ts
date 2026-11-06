/**
 * action-menu.host-act — whether a host's act is lit on the rail. No Angular here,
 * so a keeper can ask it of real project records.
 */
import { canRunHostActFrom, type HostActAim } from '@owen/foundry-core/shared/stages';
import type { ProjectSummary } from '@owen/foundry-core/shared/types';

/**
 * THE GRAY READS THE PRESS. A tile is dark when its press could only answer that
 * the book is standing on a scan, so the two cannot disagree (Owen, 2026-11-06, on
 * a bare PDF: *"we can narrate once OCR has run, but higgs cant read a pdf"*).
 *
 * `canRunHostActFrom` alone was not enough: it reads the catalogue, and a catalogue
 * says "read" for a bank being filled right now and for a reading whose step was
 * deleted, on a book whose ledger holds nothing but the scan.
 *
 * THE OTHER TWO REFUSALS STAY LIT: several exports, and a history still loading, are
 * each answered by a sentence that tells the person what to do.
 */
export function hostActLit(project: ProjectSummary | null, aim: HostActAim): boolean {
  if (!canRunHostActFrom(project)) return false;
  return aim.kind === 'node' || aim.why !== 'a-scan';
}
