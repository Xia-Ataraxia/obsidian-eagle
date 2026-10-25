# CLAUDE.md

Root `AGENTS.md` rules apply. Plugin id `eagle` (never change); repo `obsidian-eagle`.

## Commands

`bun run dev` (watch to `dist/`), `bun run build`, `bun run ci` (build + typecheck + lint + test). Releases are CI-only via `bun run release <bump>`; infra lives in `GoBeromsu/obsidian-boiler-template`.

## Architecture

- `src/main.ts`: plugin lifecycle, paste/drop handlers, commands, cache sync.
- `src/ui/`: Eagle REST client (`EagleUploader`), cache/hash stores, modals, settings tab (declarative `getSettingDefinitions()`, `minAppVersion` 1.13.0), notices.
- `src/domain/`, `src/utils/`, `src/types/`: pure logic; must not import `obsidian` (lint-enforced). Tests in `test/` cover these.

## Gotchas

- Talks only to the local Eagle API (`eagleHost:eaglePort`); disclosed in README.
- Folder mapping rows are edited in memory and sanitized/saved in the tab's `hide()`; `saveSettings()` drops incomplete mappings.
- Cache folder rename is confirmed in `hide()` via `RenameCacheModal`.
- Needs runtime QA in Obsidian after UI changes (paste upload, search modal, settings).
