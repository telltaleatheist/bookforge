/**
 * quire loads Electron lazily, with `require('electron')` at the call site, so
 * that its pure parts — the archive reader, the shell builder, the protocol
 * rules — can be imported and tested with no Electron app running.
 *
 * A lazy require means TypeScript never pulls in `electron.d.ts` on its own, and
 * so never learns the global `Electron` namespace the host types are written
 * against. Referencing it here loads those types for the package's own program
 * (`packages/quire/tsconfig.json`) without turning the lazy require into an
 * eager import.
 */
/// <reference types="electron" />
