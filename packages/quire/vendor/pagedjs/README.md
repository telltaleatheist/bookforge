# Vendored: Paged.js 0.4.3

`paged.js` here is the **unmodified** browser bundle from the `pagedjs` npm package,
version **0.4.3**, MIT licensed (`LICENSE.md`, copied from the same tarball).

It is vendored rather than installed because quire injects it into an **isolated world**
inside a sandboxed frame that is showing untrusted book markup. That injection is quire's
own trusted code, and it has to be a file quire ships and can hash — not a resolved
`node_modules` graph that a lockfile change could move underneath it. Nothing is added to
the repo's `package.json`.

## Exactly how it was obtained

```sh
mkdir -p /c/tmp/pjs && cd /c/tmp/pjs
npm pack pagedjs@0.4.3          # -> pagedjs-0.4.3.tgz
tar xzf pagedjs-0.4.3.tgz       # -> package/
cp package/dist/paged.js  <repo>/packages/quire/vendor/pagedjs/paged.js
cp package/LICENSE.md     <repo>/packages/quire/vendor/pagedjs/LICENSE.md
```

`dist/paged.js` is the UMD build, **not** `paged.polyfill.js`. The polyfill build paginates
the document automatically on load; this one only defines `globalThis.Paged` and waits to be
driven, which is what quire needs — pagination has to happen when quire says so, against the
DOM quire has prepared, with quire's own page box.

## Provenance, checkable

| what | value |
|---|---|
| registry tarball | `pagedjs-0.4.3.tgz`, 1 109 854 bytes |
| tarball integrity | `sha512-YtAN9JAjsQw1142gxEjEAwXvOF5nYQuDwnQ67RW2HZDkMLI+b4RsBE37lULZa9gAr6kDAOGBOhXI4wGMoY3raw==` (matches `npm view pagedjs@0.4.3 dist.integrity`) |
| `paged.js` | 920 798 bytes, sha256 `4cae0c875c89084b353ceee87bcc742388de3133f2bbf48830b63f1d2d357e4f` |
| `LICENSE.md` | 1 076 bytes, sha256 `f49bdde202ca66880e2d7cb7fd8103f43a917a60b61681484a66cf370e7647e0` |

`.gitattributes` marks both files `-text` so git's `core.autocrlf` cannot rewrite the bytes
on checkout; without it those hashes would be true on macOS and false on Windows.

To re-verify:

```sh
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('paged.js')).digest('hex'))"
```

## Where it is used

`packages/quire/src/paginate/paged.ts` reads this file at run time (from
`<quire package root>/vendor/pagedjs/paged.js`, resolved relative to the compiled module) and
hands it to the host as the strategy's **prelude** — trusted code evaluated in the isolated
world before the measure or present script. It never reaches the book's own world, and it is
never served over `quire://`, so the book can neither see it nor call it.

`npm run build:quire-vendor` copies this directory into `dist/`, which is what the packaged app
ships. If it was not copied, `PagedStrategy` refuses by name rather than paginating without it.
