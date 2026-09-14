/**
 * WHICH CRUCIBLE MODEL EACH TEXT ACT RUNS ON — one owner, four answers.
 *
 * ── Why a model per ACT and not one per machine ─────────────────────────────
 *
 * crucible `docs/PHASE9-CAPABILITY.md` §1: *"which model FAMILY a task requires
 * — translate needs 27B-class, cleanup needs 9B-class"* is **the client's**
 * decision, a quality requirement about the work; which QUANTIZATION of that
 * family a host serves is Crucible's. So BookForge names an id per act, and the
 * four are genuinely different choices: measured 2026-09-08, the 27B runs a book
 * at ~9 blocks/min against ~50 on the 9B, and a cleanup does not need the 27B.
 *
 * This replaces nothing: `cleanTextModel` in `app-settings.json` is FOUNDRY's
 * key, naming an OLLAMA TAG for the local engines, and it goes on meaning that
 * for as long as they exist. A Crucible id is a different namespace with a
 * different owner, so it gets a different record rather than a reinterpretation
 * of somebody else's field — **a tag is never mapped onto an id by string
 * rules.** A run names a Crucible model or says it cannot.
 *
 * ── Why ONE id per act and not one per server ───────────────────────────────
 *
 * crucible `docs/PHASE2-LLM.md` §9.1, promised as a guarantee: *"The `id` in
 * `GET /v1/openai/models` is the **Crucible id** — a constant in this repo,
 * identical on every machine serving that manifest."* `qwen3.5-9b` is that name
 * on the PC and on the Mac. So an id chosen against one server is meaningful on
 * every server, and a per-server table would be four copies of one fact
 * (crucible `docs/ARCHITECTURE.md` R1) that could disagree.
 *
 * What is NOT portable is whether that id is *resident* — which is asked of the
 * chosen server at run time, every time, and is never recorded here.
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 *
 *   <userData>/crucible-models.json
 *   { "clean": "qwen3.5-9b", "translate": "qwen3.8-27b-4bit", … }
 *
 * Its own file beside `crucible-routing.json` and `crucible-servers.json`, for
 * their reason: one record, one owner, written temp-and-rename so a half-write
 * cannot lose every choice at once. An act with no entry is a NAMED state
 * (`crucible_text_model_not_set`) and never a default — there is no id this file
 * could invent that would be true of a machine it has not seen.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CRUCIBLE_TEXT_ACTS, isCrucibleTextAct, type CrucibleTextAct } from './text-acts';

/** The record on disk: an act to a Crucible model id. Absent = never chosen. */
export type CrucibleTextModels = Partial<Record<CrucibleTextAct, string>>;

export type CrucibleTextModelErrorCode =
  /** The record exists and is not the record. Refused, never replaced. */
  | 'corrupt_text_models'
  /** A name that is not one of the four acts. */
  | 'unknown_act'
  /** This act has no Crucible model chosen, and nothing may invent one. */
  | 'crucible_text_model_not_set';

export class CrucibleTextModelError extends Error {
  readonly code: CrucibleTextModelErrorCode;

  /** The code is PREFIXED onto the message — see `CrucibleTextActError`. */
  constructor(code: CrucibleTextModelErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleTextModelError';
    this.code = code;
  }
}

/** `<userData>/crucible-models.json`. Resolved at CALL time, like the registry. */
export function textModelsPath(): string {
  return path.join(app.getPath('userData'), 'crucible-models.json');
}

/**
 * The record over one file.
 *
 * A class for `Routing`'s reason: a keeper drives it over a temp file, and the
 * module-level doors below bind it to `<userData>`.
 */
export class TextModels {
  constructor(private readonly file: string) {}

  /**
   * The record as it is on disk.
   *
   * A missing file is the EMPTY record — no act has been pointed at a Crucible
   * model yet, which is a real state on every machine until somebody chooses.
   * A file that exists and does not parse is refused: it records choices an
   * operator made, and starting over silently would rewrite them.
   */
  read(): CrucibleTextModels {
    const file = this.file;
    if (!fs.existsSync(file)) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new CrucibleTextModelError(
        'corrupt_text_models',
        `${file} is not valid JSON (${(err as Error).message}). It records which Crucible model `
          + 'each text act runs on, so nothing here will replace it — repair or delete the file by '
          + 'hand.',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CrucibleTextModelError(
        'corrupt_text_models',
        `${file} is not an object of act to Crucible model id. Repair or delete the file by hand.`,
      );
    }
    const record: CrucibleTextModels = {};
    for (const [act, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isCrucibleTextAct(act)) {
        throw new CrucibleTextModelError(
          'corrupt_text_models',
          `${file} names "${act}", which is not one of the four text acts `
            + `(${CRUCIBLE_TEXT_ACTS.join(', ')}). Repair or delete the file by hand.`,
        );
      }
      if (typeof id !== 'string' || id.trim() === '') {
        throw new CrucibleTextModelError(
          'corrupt_text_models',
          `${file}: "${act}" must be a Crucible model id, not ${JSON.stringify(id)}. An act with `
            + 'no model chosen has no key at all. Repair or delete the file by hand.',
        );
      }
      record[act] = id.trim();
    }
    return record;
  }

  private write(record: CrucibleTextModels): void {
    const file = this.file;
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, file);
  }

  /**
   * Point one act at a Crucible model id, or clear it with an empty string.
   *
   * The id is NOT validated against a server here: which ids exist is a
   * question for a server, the picker asks it (`GET /v1/models`), and a record
   * that refused an id because the machine that has it happens to be asleep
   * would be a record with an opinion about somebody else's hardware.
   * Residency, which is the thing that actually blocks a run, is asked at run
   * time and never recorded.
   */
  set(act: string, id: string): CrucibleTextModels {
    if (!isCrucibleTextAct(act)) {
      throw new CrucibleTextModelError(
        'unknown_act',
        `"${act}" is not one of the four text acts (${CRUCIBLE_TEXT_ACTS.join(', ')}). They are `
          + "crucible's own capability classes and are named truthfully per run.",
      );
    }
    const record = this.read();
    const trimmed = id.trim();
    if (trimmed === '') delete record[act];
    else record[act] = trimmed;
    this.write(record);
    return record;
  }

  /**
   * The model this act runs on, or a refusal naming the act and the door.
   *
   * Never a default. A cleanup answered by a model nobody chose is a book
   * cleaned by weights nobody can name afterwards.
   */
  require(act: CrucibleTextAct): string {
    const id = this.read()[act];
    if (id === undefined) {
      throw new CrucibleTextModelError(
        'crucible_text_model_not_set',
        `no Crucible model is chosen for the "${act}" act. Pick one in Settings → AI → Crucible `
          + '(the per-act pickers list the chosen server\'s models, with resident/loadable and the '
          + 'reason for a no). There is no default: a Crucible model id is whatever that host has '
          + 'manifests for, and an Ollama tag is not one.',
      );
    }
    return id;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The app's record
// ─────────────────────────────────────────────────────────────────────────────

function store(): TextModels {
  return new TextModels(textModelsPath());
}

/** Every act's chosen Crucible model id. Acts with no choice have no key. */
export function readTextModels(): CrucibleTextModels {
  return store().read();
}

/** Point one act at a model id, or clear it with an empty string. */
export function setTextModel(act: string, id: string): CrucibleTextModels {
  return store().set(act, id);
}

/** The model this act runs on. Refuses `crucible_text_model_not_set`. */
export function textModelFor(act: CrucibleTextAct): string {
  return store().require(act);
}
