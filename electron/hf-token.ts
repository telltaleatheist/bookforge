/**
 * THE HUGGINGFACE TOKEN, AND THE ORDER IT IS LOOKED FOR IN.
 *
 * One reader, because a second would answer differently the first time somebody
 * added a source and forgot the other (crucible `docs/ARCHITECTURE.md` R1). Two
 * callers survive today: the whisper model download and the text server's
 * gated-repo pull.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * It lived in `orpheus-hf-catalog.ts`, which was the Orpheus voice catalogue and
 * is deleted with the local weights machinery (docs/LEGACY-REMOVAL.md). The
 * token is not an Orpheus fact — it is this machine's credential — so it comes
 * out rather than going down with the file.
 *
 * ── The order, and why it is this order ────────────────────────────────────
 *
 * The SETTINGS value wins: it is the one a person typed into this app, and an
 * app that ignored it in favour of an environment variable they set years ago
 * would be unexplainable. Then the environment, under either of the two names
 * the HuggingFace tooling itself accepts. Then the two files on disk, BookForge's
 * own first and the `huggingface-cli login` cache second.
 *
 * `null` is a real answer and not a failure: public repos need no token, and the
 * caller that needs one says so by name rather than this guessing.
 *
 * A TOKEN NEVER APPEARS IN A LOG, A FILENAME OR AN ARGV. Callers put it in the
 * child's ENVIRONMENT — see `higgs_download.py`'s and `orpheus_download.py`'s
 * invocations, which pass `HF_TOKEN` that way for exactly this reason.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig } from './tool-paths';

export function getHfToken(): string | null {
  const fromSettings = getConfig().huggingFaceToken?.trim();
  if (fromSettings) return fromSettings;
  const fromEnv = process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const files = [
    path.join(os.homedir(), '.config', 'bookforge', 'hf-owenmorgan.token'),
    path.join(os.homedir(), '.cache', 'huggingface', 'token'),
  ];
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, 'utf-8').trim();
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  return null;
}
