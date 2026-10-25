<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-03-25 -->

Eagle Plugin for Obsidian — uploads images to Eagle instead of storing them locally in the vault.

## Build Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Vault selection + esbuild watch + hot reload |
| `pnpm dev:build` | esbuild watch only (no vault) |
| `pnpm build` | Production build (single-shot) |
| `pnpm run ci` | build + lint + test |
| `pnpm test` | Vitest run |
| `pnpm test:ui` | Vitest with UI |
| `pnpm verify` | Build, reload plugin in vault, run verify script |
| `pnpm lint` | ESLint check |
| `pnpm lint:fix` | ESLint auto-fix |
| `pnpm release:patch` | run CI, patch bump, auto-push tag |
| `pnpm release:minor` | run CI, minor bump, auto-push tag |
| `pnpm release:major` | run CI, major bump, auto-push tag |

## Architecture (4-layer)

```
src/
├── main.ts                         # Composition root — registers commands, paste handlers, events
├── domain/
│   ├── EagleApiError.ts            # Typed Eagle API error class
│   ├── folder-mapping.ts           # Obsidian folder → Eagle folder mapping (pure logic)
│   └── settings.ts                 # Settings interface + defaults (host, port, cache folder, dedup)
├── ui/
│   ├── Canvas.ts                   # Canvas paste handler (intercepts image pastes)
│   ├── EagleCacheManager.ts        # Local vault cache — writes Eagle thumbnails via vault.adapter
│   ├── EagleHashStore.ts           # Content-hash → Eagle item ID dedup store
│   ├── EagleUploader.ts            # Eagle REST API client (add from path, folder ops, item search)
│   ├── EaglePluginSettingsTab.ts   # Settings tab UI
│   ├── EagleSearchPickerModal.ts   # Eagle item search/picker modal
│   ├── ImageUploadBlockingModal.ts # Progress modal during upload
│   ├── InfoModal.ts                # Generic info modal
│   ├── RenameCacheModal.ts         # Rename cached items modal
│   ├── UpdateLinksConfirmationModal.ts  # Confirmation before bulk link updates
│   ├── VaultFolderSuggestModal.ts  # Folder suggestion modal
│   ├── editor.ts                   # Editor helpers (find file under cursor, replace text)
│   ├── file-url.ts                 # file:// URL ↔ OS path conversion
│   ├── misc.ts                     # Miscellaneous UI utilities
│   └── obsidian-vault.ts           # Vault path helpers
├── types/
│   └── obsidian.d.ts               # Extended Obsidian type declarations
├── utils/
│   ├── events.ts                   # ClipboardEvent utilities (buildPasteEventCopy)
│   ├── FileList.ts                 # File list helpers (e.g. allFilesAreImages)
│   ├── image-format.ts             # Image extension extraction
│   ├── item-naming.ts              # Upload item name template resolution ({uuid}_{noteName})
│   ├── markdown-image.ts           # Markdown/wikilink image token parsing and replacement
│   └── pseudo-random.ts            # Pseudo-random ID generation
└── shared/                         # Repo-local shared helpers (logger, notices, debounce, settings migration)
    ├── debounce-controller.ts      # Debounce utility
    ├── plugin-logger.ts            # Structured logger (use console.debug/warn/error only)
    ├── plugin-notices.ts           # Obsidian Notice wrappers
    └── settings-migration.ts       # Settings version migration helper
```

## Layer Rules

| Layer | `obsidian` import? | Side effects? |
|-------|--------------------|---------------|
| `utils/` | **No** | No — pure functions only |
| `types/` | **No** | No — type declarations only |
| `domain/` | **No** | Injected only — testable with simple stubs |
| `ui/` | Yes | Yes — DOM, I/O, Obsidian API |
| `shared/` | Yes | Yes — repo-local helper layer |
| `main.ts` | Yes | Yes — composition root |

## Key Config

- `boiler.config.mjs` — dev deploy paths, version stage files, CI config, release artifact list
- `scripts/version.mjs` — bumps `manifest.json` and `versions.json`, stages via git add

## Release

1. `pnpm run ci` — MUST pass (build + lint + test)
2. `pnpm release:patch|minor|major` — run CI, version bump, auto-push tag
3. GitHub Actions handles CI + Release workflows

**DENIED by settings.json:** `git tag`, `git push --tags`, `gh release` — only `pnpm release:*` is allowed.

## References

- Eagle API: https://api.eagle.cool/

## Gotchas

- `.gitignore` has a `release/` pattern that blocks `.claude/skills/release/` — a negation rule `!.claude/skills/release/` is in place
- hookify security hook blocks RegExp patterns containing the exec-paren sequence — use `.match()` or `.matchAll()` instead
- esbuild always succeeds even with TS errors; use `pnpm tsc --noEmit` to check types
- Cache sync: never evicts on uncertain failures (`itemExists()` returns `null` on network error)
- Image format in notes: `![[eagle-cache/ITEMID.EXT]]` (wikilink embed, vault-relative); old format `![eagle:ID](file://...)` kept for backward compat
- `scripts/`, `.github/workflows/`, and `src/shared/` are maintained in this repo; keep their evidence shape aligned with family harness expectations, but treat implementation details as local authority

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | All source layers (see `src/AGENTS.md`) |
| `src/domain/` | Business logic — NO obsidian imports (see `src/domain/AGENTS.md`) |
| `src/ui/` | Obsidian-dependent views, modals, settings, API client (see `src/ui/AGENTS.md`) |
| `src/types/` | Pure type definitions (see `src/types/AGENTS.md`) |
| `src/utils/` | Pure utility functions (see `src/utils/AGENTS.md`) |
| `src/shared/` | Repo-local helper files for logging, notices, debouncing, and settings migration (see `src/shared/AGENTS.md`) |
