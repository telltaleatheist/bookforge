/**
 * Token-only stand-ins for the modules export.service.ts imports but whose code
 * the EPUB generator never runs.
 *
 * `PdfService`, `ElectronService` and `Router` reach the generator only as
 * injection TOKENS — the values behind them are used exclusively by the
 * download/save wrappers. Left in the bundle they drag the whole renderer
 * import graph along, including a prebuilt Angular library whose compiled
 * `ɵɵngDeclareFactory` calls run at module load and cannot be satisfied outside
 * Angular. Pruning them here keeps the bundle to the file actually under test.
 *
 * Everything else those modules export from export.service.ts's point of view
 * is a TypeScript type, which esbuild erases, so nothing else is needed.
 */
'use strict';

class PdfService {}
class ElectronService {}
class Router {}

module.exports = { PdfService, ElectronService, Router };
module.exports.__esModule = true;
