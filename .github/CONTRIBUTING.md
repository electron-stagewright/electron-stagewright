# Contributing to Electron Stagewright

This project is in its earliest days. The architecture is locked; the implementation is underway.

If you're reading this before the first release ships: thanks for stopping by. The most useful contribution right now is **opening a discussion** with use cases or pain points from your own Electron testing experience — that input shapes which plugins land first.

## How we work

- Architectural direction is maintained by the maintainers and discussed publicly in GitHub Issues and Discussions before structural changes land.
- All discussion happens in GitHub Issues and Discussions (no private channels until the project grows).
- Conventional Commits format for commit messages.
- Pull requests require: passing CI (`pnpm verify`), conventional commits, a reasonably-scoped diff.

## Local development

```bash
git clone https://github.com/electron-stagewright/electron-stagewright.git
cd electron-stagewright

# Enable Corepack-managed pnpm
corepack enable

pnpm install
pnpm verify  # lint + typecheck + test + build + format check
```

## Project structure

```
electron-stagewright/
├── examples/                 # Example Electron apps + scripted scenarios
├── packages/
│   └── core/                 # @electron-stagewright/core — MCP server
└── scripts/                  # Build / release tooling
```

Future plugin packages live under `packages/plugin-*/` and publish as `@electron-stagewright/plugin-*`.

## Code style

- TypeScript strict mode (see `tsconfig.base.json`).
- ESM only — no CommonJS.
- Prettier-formatted (run `pnpm format`).
- ESLint with `@typescript-eslint`.

## Public-repo content policy — no internal-planning references

This repository ships **only** content that is intended to remain public and stable. Internal planning vocabulary stays out of the codebase, documentation, commit messages, PR descriptions, and code comments. Concretely:

- **Do not** reference iteration codes, sprint codes, milestone labels, internal ticket IDs, or roadmap shorthand (e.g. `Hito X`, `Sprint Y`, `RL-XXX`, `TIK-XXX`, "lands in week N", "by Q3"). If a fix or feature has internal planning context, leave that context in the internal tracker and write the public artifact (code, doc, commit) so it stands alone without it.
- If you find an existing reference to internal planning in this repo, fix it inline as part of whatever PR you're working on, no separate ticket needed.

This policy keeps the public artifact legible to people who arrive without prior context, and avoids leaking ephemeral planning vocabulary that loses meaning the moment the milestone closes.

## Reporting issues

Use the issue templates. For security vulnerabilities, see [SECURITY.md](./SECURITY.md) — do **not** open a public issue.

## License

By contributing, you agree your contributions are licensed under MIT (see [LICENSE](../LICENSE) at the repo root).
