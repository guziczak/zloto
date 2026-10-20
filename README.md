# GUZICZAK — portfolio

The portfolio is a self-contained HTML application with WebGL, audio and document
views. It is published as a GitHub Pages **project site** at
<https://guziczak.github.io/zloto/>.

## Source and generated pages

`index.html` is the canonical, authored document. Its inline engine code, shaders,
styles and source-viewer behavior remain together. Do not edit `cv/index.html` or
`score/index.html`: the build generates both from the current root document.

The shared URL contract lives in `site.config.json`. It defines the site origin,
project base path, supported languages, three public routes and original CV/score
resources. `src/routes.cjs` is a dependency-free, pure URL model used by the browser,
the build and the tests. It does not access the DOM or change browser history.

The build injects the configuration and route model between the
`BEGIN GENERATED ROUTES` and `END GENERATED ROUTES` comments in `index.html`.
Those marked contents are generated too. Edit their source files, then rebuild.

| Public URL | Published file |
| --- | --- |
| `/zloto/` | `index.html` |
| `/zloto/cv/` | `cv/index.html` |
| `/zloto/score/` | `score/index.html` |

Each generated document has its own initial title, description, canonical URL and
Open Graph metadata. Its document view is visible before JavaScript runs; the home
view and the other document view are hidden and inert. Ordinary links work on direct
entry, refresh and in a new tab. With JavaScript, the existing route adapter can keep
the home scene mounted while changing views.

Without JavaScript, document pages provide real navigation links and links to the
original CV HTML/PDF files in Polish, English and German, or the original score
image/PDF. These originals remain hosted at the locations in `site.config.json`;
the build neither downloads nor embeds them. They require a network connection.

The generated entries intentionally contain the full shared document at this stage.
This keeps the existing engine and inline source display intact while fixing static
routing. They are reproducible output, not separately maintained copies. Splitting
engine assets or rendering smaller document-only bundles is a separate change.

## Build

Use Node.js 20 or newer. There are no npm dependencies and no installation step.
The CI workflow uses Node.js 24.

```bash
node scripts/build.cjs
node scripts/build.cjs --check
```

The first command updates the injected root block, metadata and fallback links, then
generates the two document entries and `.nojekyll`. Commit all changed generated
files together with the source changes. Rebuilding without changing inputs produces
identical bytes; there are no timestamps or network calls in the build.

`--check` is read-only. It exits with a nonzero status when the root injection or any
published output is stale or missing. For an isolated preview without changing the
published source files, use:

```bash
node scripts/build.cjs --out-dir .build-preview
```

The exported `renderSite({ rootDir })` function returns the expected publication
files as a `Map`. `build({ rootDir, outputDir, check })` is also available to tests.
A separate output directory receives generated files only; it is not a source copy.

## Verify

```bash
node tests/routes.test.cjs
node tests/router-integration.test.cjs
node tests/static-routes.test.cjs
node tests/audio-regression.cjs index.html
node tests/runtime-regression.cjs
```

Or run `npm run check` to check generated output and run all of those suites. The
route checks include the shared URL model and the built files served without SPA
fallbacks. Existing audio and runtime checks continue to execute the inline source.
See [tests/README.md](tests/README.md) for their coverage and manual rendering,
audio and physical-device limitations.

After deployment, check direct visits to `/zloto/cv/` and `/zloto/score/`, reload,
new-tab links, Back/Forward, language and format changes, and a nonexistent route.
Use a static server that serves actual files when testing the built site; a dev
server that silently rewrites unknown paths to `index.html` can hide route defects.

## Publishing and CI

GitHub Pages continues to publish the **main branch, repository root** using its
existing branch-based Pages deployment. This change does not migrate hosting or
change Pages settings. Generated entry files and `.nojekyll` must therefore be
committed to `main`; an uncommitted local build is not a deployment.

`.github/workflows/check.yml` is a read-only check for pushes and pull requests. It
checks generation drift, route/static behavior, audio and runtime regressions. The
Actions references are pinned to verified release commits, and the workflow has
only `contents: read` permission.

This check reports failures but does **not gate the independent branch-based Pages
deployment**. Enforcing publication only after successful checks would require a
separate, explicit deployment/branch-policy change.
