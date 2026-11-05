# libxml2 as WebAssembly

**Status: the shim, the build script and `electron/narrator/text/html/libxml2-wasm.ts` have never been
compiled or run.** There is no `libxml2.wasm` yet. Installing Emscripten is waiting on Owen.

Narrator's prep reads every EPUB's package files through libxml2's XML parser, and its nav and
every document through its HTML parser and serializer before BeautifulSoup sees them, and real books depend on that parser's recovery rules: 247 documents in
the library change structure under it and 17 are not well-formed XML. So prep keeps the same
engine at the same version instead of a copy of its rules. See `docs/NARRATOR-TS-PORT-MAP.md`.

## What is here

| File | What it is |
|---|---|
| `shim.c` | The calls lxml 6.1.1 makes, and nothing more |
| `build.js` | Checks the source hash, configures, compiles |
| `LICENSE.libxml2` | libxml2's licence, which ships with the binary |
| `libxml2.wasm` | The built binary, committed once it exists |

The app and its install use only the committed binary. They never need Emscripten.

`shim.c` also holds the parts of lxml's own behaviour that have to touch libxml2's nodes: the
tail text after an element, `len(element)`, `find('body')`, and the tree as `.text`, `.tail` and
`.nsmap` present it. The rest of lxml's and ebooklib's
behaviour (the empty-body rule, the `<body>` strip, "Document is empty") belongs in TypeScript.

## Source

libxml2 2.11.9, the version lxml 6.1.1's Windows wheel carries.

- `https://download.gnome.org/sources/libxml2/2.11/libxml2-2.11.9.tar.xz`
- sha256 `780157a1efdb57188ec474dca87acaee67a3a839c2525b2214d318228451809f`

`build.js` refuses any other file.

## Rebuilding

1. Install Emscripten 6.0.13 somewhere outside the repo. No PATH or system change is needed:
   `python emsdk.py install 6.0.13`, then `python emsdk.py activate 6.0.13`. It is about 2 GB and only
   the build needs it, so it can be deleted and re-downloaded this way.
2. Run `node vendor/libxml2-wasm/build.js <tarball> <emsdk dir> <work dir>`.
3. Run the byte comparison before committing a new binary.
