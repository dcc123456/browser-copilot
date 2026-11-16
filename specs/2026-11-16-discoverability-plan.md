# Discoverability plan

## Goal

Make the project's category, differentiators, and common questions explicit to search crawlers and answer engines without keyword stuffing or inaccurate claims.

## Changes

- Put a concise AI browser-automation definition near the top of both READMEs.
- Add realistic prompt examples, a factual comparison with adjacent tools, and bilingual FAQ entries.
- Align both website homepages with the same terminology, add visible use cases and FAQs, and expose matching JSON-LD.
- Add `robots.txt`, `sitemap.xml`, and a concise `llms.txt` index to the existing GitHub Pages site.
- Keep the existing repository description/topics; they already cover the core category. Recommend additional topics after review rather than replacing them blindly.
- Do not submit to third-party directories or post publicly without separate approval.

## Verification

- Run the documentation build check, formatting, type checks, tests, lint, and production build required by the repository gates.
- Serve `website/` locally and inspect both homepages and crawler files in a browser.
- Check that internal links and JSON-LD are valid and that both languages make the same claims.
