# Workflow operator docs site — plan/design

Date: 2026-10-24
Area: website / docs
Status: implemented

## Goal

Give the landing page a documentation site that explains every workflow operator available in
the palette, with Browser Copilot-specific behavior that the upstream Automa docs do not cover.
Markdown under `docs/workflow/` is the source of truth; static HTML is generated into
`website/docs/` and published by the existing GitHub Pages workflow.

## Why a generator instead of hand-written HTML

`website/` is published verbatim (`pages.yml` uploads the directory, no build). Hand-maintaining
8 pages x 2 languages of HTML next to Markdown would duplicate content and drift. A single
Node script (`scripts/build-docs.mjs`) renders Markdown to HTML, builds the shared shell
(nav/sidebar/TOC/footer), rewrites source links, validates anchors, and formats the output with
Prettier. Generated files are committed so Pages needs no new build step.

Rejected alternatives:

- VitePress/MkDocs/Docusaurus: new site framework, new deployment pipeline, violates
  AGENTS.md §5.6 (no second documentation infrastructure).
- Client-side Markdown rendering from CDN: docs content would have to be duplicated under
  `website/`, and the site would lose content without JavaScript.
- Hand-written HTML only: unacceptable duplication for 63 operators x 2 languages.

## Dependency

`marked` (devDependency) is the only addition: ESM, zero runtime dependencies, GFM tables.
It is used only at generation time; the published site remains static HTML.

## Structure

Source pages (each with a `.zh-CN.md` counterpart):

- `README.md` — overview, status legend, generated 63-operator index
- `getting-started.md`
- `concepts.md`
- `operators-interaction.md` (14)
- `operators-browser.md` (18, including OCR)
- `operators-general.md` (13, including AI agent)
- `operators-data.md` (11, including set-variable/get-secret/parse-excel)
- `operators-conditions.md` (7)

Generated pages are flat: `website/docs/<slug>.html` and `<slug>-zh.html`.

Operator sections carry an invisible marker `<!-- operator:<block-id> -->` (plus an optional
`status:<kind>` token). The generator turns the marker into `id="operator-<block-id>"`, uses it
for the sidebar/index links, and the coverage test uses it to prove every palette operator is
documented exactly once. Anchors are language-independent.

## Automa links

The property panel links to `https://docs.extension.automa.site/blocks/<id>.html`, which
redirects to `https://www.goautoma.com/extension/docs/blocks/<id>.html`. Docs use the canonical
target. curl checks on 2026-10-24 found no upstream page for `note`, `forward-page`,
`save-local`, and `read-page`; the five custom blocks also have none. Those sections omit the
link and say so. Prose is original; upstream pages are linked, not copied.

## Coverage guard

`tests/workflow-docs.spec.ts` reads the Markdown and committed HTML. It asserts marker coverage
against `PALETTE_BLOCKS`, category placement, localized headings (`BLOCK_NAMES_ZH`), Automa-link
presence, status tokens, EN/ZH parity, and that the generated pages are fresh (anchors and index
links present). It does not validate every field label; the property panel remains the source
of truth for fields, which each category page states.

## Verification

`pnpm docs:build`, `pnpm docs:check`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`,
`pnpm lint`, plus a manual pass over the locally served `website/` (navigation, anchors,
language switch, mobile layout). CI/Pages workflows are unchanged.
