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

// Approximate per-pack download size for the UI. The true size is reported by
// the download helper's BF_PROGRESS lines, so this is only a headline estimate.
const STANZA_APPROX_BYTES = 250_000_000;

/**
 * The Stanza languages BookForge can download, keyed by ISO 639-1 code. Sorted
 * alphabetically by English name.
 *
 * Only languages with an actual sentence-segmentation (tokenize) model are
 * listed. Stanza's manifest also contains a few "phantom" languages that have a
 * lang_name but ship ONLY character language models (no tokenize package) —
 * Bengali (bn), Malayalam (ml), Sinhala (si). `stanza.download()` raises
 * KeyError('packages') for those, so they'd fail deterministically; they're
 * intentionally excluded. (Audited against Stanza 1.10.x: 3 of 67.)
 */
export const STANZA_LANGUAGES: { code: string; name: string }[] = [
  { code: 'sq', name: 'Albanian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' },
  { code: 'af', name: 'Afrikaans' },
  { code: 'eu', name: 'Basque' },
  { code: 'be', name: 'Belarusian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'my', name: 'Burmese' },
  { code: 'ca', name: 'Catalan' },
  { code: 'zh-hans', name: 'Chinese (Simplified)' },
  { code: 'zh-hant', name: 'Chinese (Traditional)' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'et', name: 'Estonian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'is', name: 'Icelandic' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ga', name: 'Irish' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'ko', name: 'Korean' },
  { code: 'ky', name: 'Kyrgyz' },
  { code: 'la', name: 'Latin' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'mt', name: 'Maltese' },
  { code: 'mr', name: 'Marathi' },
  { code: 'nb', name: 'Norwegian Bokmål' },
  { code: 'nn', name: 'Norwegian Nynorsk' },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sa', name: 'Sanskrit' },
  { code: 'gd', name: 'Scottish Gaelic' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sd', name: 'Sindhi' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ug', name: 'Uyghur' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'cy', name: 'Welsh' },
  { code: 'wo', name: 'Wolof' },
];

/** Build the downloadable language-pack catalog: one component per language. */
export function languagePackComponents(): OptionalComponent[] {
  return STANZA_LANGUAGES.map((lang) => {
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
