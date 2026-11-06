/**
 * A VOICE'S EDGES, RECORDED IN THE SESSION WHEN IT RENDERS (ruling, 2026-11-05).
 *
 * How a voice's chunks join is a fact Crucible owns: `edges` on the voice's `GET /v1/voices`
 * row. Assembly never asks a server for it. The render door writes it into
 * `session-state.json`, and assembly reads that, so a voice changing later cannot change an
 * old book, and a reassembly needs no server up.
 *
 * A session keeps what it began under:
 *  - The first record wins. A resume on a recorded session rewrites nothing, whatever the
 *    server says now, and an attach to a running job reads no row at all.
 *  - A session with chunks on disk and no record began before this existed. It gets no
 *    record and it is not refused: assembly reads `PRE_FLIP_EDGES` for it. A session begun
 *    after this cannot look like that, because its record is written before its first submit.
 *  - Anything else is a new render, and a voice whose row states no edges is refused here,
 *    before a chunk is sent. This refusal is the only guard: assembly cannot tell a pre-flip
 *    session from one that lost its record.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VoiceEdges } from '@crucible/client';
import {
  readStateFile, saveSessionState, scanCompletedSentences, SESSION_STATE_FILENAME,
} from '../narrator/session/session-store';
import { processDirOfSentencesDir } from './render-holds';
import { CrucibleRenderRefused } from './render';

export async function recordSessionEdges(
  sentencesDir: string,
  server: string,
  voice: string,
  edges: VoiceEdges | null,
  log: (line: string) => void,
): Promise<void> {
  const processDir = processDirOfSentencesDir(sentencesDir);
  const file = path.join(processDir, SESSION_STATE_FILENAME);
  if (!fs.existsSync(file)) {
    throw new CrucibleRenderRefused(
      'crucible_session_state_missing',
      `there is no ${SESSION_STATE_FILENAME} at ${processDir} to record voice "${voice}"'s edges in. Prep writes it.`,
    );
  }
  const state = await readStateFile(file);
  if ('edges' in state) {
    log(`this session keeps the edges it began under: ${JSON.stringify(state['edges'])}`);
    return;
  }
  const total = state['total_sentences'];
  if (typeof total !== 'number') {
    throw new CrucibleRenderRefused(
      'crucible_session_state_missing',
      `${file} has no total_sentences, so this render cannot tell whether the session already has chunks.`,
    );
  }
  const { completed_count: rendered } = await scanCompletedSentences(sentencesDir, total);
  if (rendered > 0) {
    log(`this session has ${rendered} chunk(s) and no recorded edges: it began before edges were recorded, and assembly keeps it on the pre-flip record`);
    return;
  }
  if (edges === null) {
    throw new CrucibleRenderRefused(
      'crucible_voice_states_no_edges',
      `crucible "${server}" states no edges for voice "${voice}", so nothing says how this book's chunks join. `
      + 'Update that server, or check the voice has an arm on it.',
    );
  }
  const record = { pads: edges.pads, fade_in_ms: edges.fadeInMs, fade_out_ms: edges.fadeOutMs };
  await saveSessionState(processDir, { ...state, edges: record });
  const written = (await readStateFile(file))['edges'];
  if (JSON.stringify(written) !== JSON.stringify(record)) {
    throw new Error(`${file} did not keep the edges written to it: wrote ${JSON.stringify(record)}, read ${JSON.stringify(written)}`);
  }
  log(`recorded voice "${voice}"'s edges in the session: ${JSON.stringify(record)}`);
}
