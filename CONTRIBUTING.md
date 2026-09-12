# Contributing

Thanks for helping improve Browser Copilot.

## Setup

The repo uses pnpm (pinned via `packageManager`; enable it with
`corepack enable` or use `corepack pnpm <cmd>`).

```bash
pnpm install
pnpm dev          # extension dev build
pnpm server:dev   # headless runner
```

## Before you open a PR

```bash
pnpm typecheck     # src + tests
pnpm test          # full unit suite
pnpm lint          # eslint (0 errors required)
pnpm format:check  # prettier
pnpm build         # extension bundle
pnpm bench:debug   # offline AI-debug success-rate gate
pnpm server:typecheck && pnpm server:test
```

CI runs the same gates. `pnpm lint` must report **0 errors**; warnings are
tolerated but should not grow.

## Conventions

- **Commit messages in English**, Conventional Commits format
  (`feat(scope): …`, `fix(scope): …`). See `AGENTS.md`.
- **Styling is Tailwind-only** with the semantic design tokens
  (`bg-panel`, `text-muted`, …). No hardcoded hex colours, no CSS-in-JS, no new
  CSS classes for one-off styles. See `AGENTS.md`.
- Keep `src/lib/**` chrome-free. Anything that must run in both the extension
  and the headless runner belongs there.
- New behaviour needs a test. The engine's AI-debug path additionally has an
  offline benchmark (`tests/bench/`) that must not regress.

## The AI-debug pipeline

`docs/ai-debug-success-rate-v3.md` is the source of truth for the takeover /
debug work. Its success metric is strict:

> **verified = a takeover-free verification run passed AND the goal was
> achieved.**

If you change anything in `src/lib/workflow/ai-takeover.ts`,
`src/background/workflow-engine/**` or the takeover loops, run
`pnpm bench:debug` and report the before/after success rate in your PR.
