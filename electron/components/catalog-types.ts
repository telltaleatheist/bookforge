/**
 * Shapes of the remote catalog (catalog.json) published by the catalog indexer
 * (tools/catalog-indexer/) on the bookforge repo's `catalog-data` branch, served
 * via raw.githubusercontent.com.
 *
 * The catalog is the source of truth for WHICH voices and language packs are
 * downloadable. It carries download coordinates only — it does NOT host the
 * model files (those come from HuggingFace).
 */

export interface CatalogVoice {
  id: string;        // == HuggingFace folder name == XTTS preset id
  name: string;      // curated display name
  lang: string;      // e.g. 'eng', 'deu', 'rus'
  engine: string;    // 'xtts'
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
