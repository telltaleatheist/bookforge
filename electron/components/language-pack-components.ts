/**
 * Downloadable Stanza language packs as optional components.
 *
 * BookForge bundles a handful of Stanza sentence-segmentation models (en/de/es/
 * ko). Every other language is a managed `language-pack` component: a one-click
 * download fetches the model into e2a's models/stanza/<code>/ (kind
 * 'language-pack'), where the segmentation pipeline reads it via
 * STANZA_RESOURCES_DIR with no special-casing.
 *
 * These are managed-only — BookForge downloads them; there is no external/locate
 * mode. The real download size comes from the helper's progress; sizeBytes here
 * is only an approximate headline for the UI.
 */

import type { OptionalComponent } from './component-types';
import { catalogService } from './catalog-service';

// Approximate per-pack download size for the UI. The true size is reported by
// the download helper's BF_PROGRESS lines, so this is only a headline estimate.
const STANZA_APPROX_BYTES = 250_000_000;

/**
 * The Stanza languages BookForge can download come from the remote catalog
 * (CatalogService), generated from the Stanza resources manifest. The indexer
 * already filters to languages with a real `tokenize` (segmenter) model, so the
 * "phantom" languages that ship only character LMs (Bengali, Malayalam, Odia,
 * Sinhala) — which crash `stanza.download()` with KeyError('packages') — are
 * excluded at the source. Until the first network refresh, CatalogService serves
 * the bundled snapshot, so this is never empty.
 */
export function stanzaLanguages(): { code: string; name: string }[] {
  return catalogService.languages().map((l) => ({ code: l.code, name: l.name }));
}

/** Build the downloadable language-pack catalog: one component per language. */
export function languagePackComponents(): OptionalComponent[] {
  return stanzaLanguages().map((lang) => {
    return {
      id: `stanza-${lang.code}`,
      name: `${lang.name} Language Pack`,
      description: `Stanza sentence-segmentation model for ${lang.name}. Needed to clean & translate ${lang.name} text.`,
      kind: 'language-pack',
      acquisition: ['managed'],
      sizeBytes: STANZA_APPROX_BYTES,
      requirements: { gpu: 'none' },
      artifacts: [],
      stanza: { code: lang.code },
      verify: { kind: 'path-exists' },
      version: '',
      entryPath: '', // set to the downloaded stanza/<code> dir at install time
    } satisfies OptionalComponent;
  });
}
