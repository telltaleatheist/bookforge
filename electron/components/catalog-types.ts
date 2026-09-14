/**
 * Shapes of the remote catalog (catalog.json) published by the catalog indexer
 * (tools/catalog-indexer/) on the bookforge repo's `catalog-data` branch, served
 * via raw.githubusercontent.com.
 *
 * The catalog is the source of truth for WHICH voices and language packs are
 * downloadable. It carries download coordinates only — it does NOT host the
 * model files (those come from HuggingFace).
 */

/**
 * One voice in the REMOTE UPDATE CATALOG — a shape from the XTTS era.
 *
 * **RULING OWED (audit docs/SETUP-AND-SETTINGS-AROUND-CRUCIBLE.md section 9,
 * ruling 10): is the remote update catalog's voice shape needed at all?** It
 * describes an engine that left the build on 2026-09-05, and every field below
 * is phrased in its terms — a folder name that was an XTTS preset id, an HF
 * sub-path under `xtts-v2/`. It is NOT deleted here because it is still
 * imported by `electron/update/manifest-types.ts`, which types the update
 * catalog the app fetches; deleting a type somebody else's JSON is parsed
 * against is a decision about that catalog, not about XTTS. The examples below
 * are left as they were written, because inventing modern-looking ones would
 * hide what this actually describes.
 */
export interface CatalogVoice {
  id: string;        // == HuggingFace folder name (an XTTS preset id, historically)
  name: string;      // curated display name
  lang: string;      // e.g. 'eng', 'deu', 'rus'
  engine: string;    // 'xtts' in every catalog ever published against this shape
  repo: string;      // HF repo id
  sub: string;       // HF sub-path, e.g. 'xtts-v2/eng/ScarlettJohansson/'
  files: string[];   // checkpoint files to download (config.json, model.pth, vocab.json)
  ref: string;       // reference clip filename in the folder, downloaded with the model
  sizeBytes: number; // sum of `files` + `ref`
}

export interface CatalogLanguage {
  code: string;            // Stanza language code, e.g. 'de'
  name: string;            // display name from the Stanza manifest
  engine: string;          // 'stanza'
  sizeBytes: number | null;
}

export interface CatalogData {
  schemaVersion: number;
  generatedAt: string;
  generator: string;
  sources: { voices: string; languages: string };
  counts: { voices: number; languages: number };
  voices: CatalogVoice[];
  languages: CatalogLanguage[];
}
