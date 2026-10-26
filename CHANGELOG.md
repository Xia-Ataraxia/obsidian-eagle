# obsidian-eagle-plugin changelog

## [Unreleased]

### Removed

- **Sync Eagle cache for all notes** and **Migrate all images to the cache folder** commands. They read every note in the vault; the plugin now only reads the note you have open.

### Changed

- Older `<id>.<ext>` cache links are renamed to `<name>_<id>.<ext>` per note when you open or edit it. The old cache file is kept, since other notes may still link it.
- Renaming the cache folder finds the notes to update from Obsidian's link index instead of reading every note.
- Links from versions before 2.0 (`![eagle:ID](...)`) still render but are no longer converted.

## [2.0.9] - 2026-02-21

### Fixed

- Search modal thumbnails now render for mixed Eagle thumbnail formats by resolving
  local file paths, `/api/...` paths, and absolute `http(s)://` / `file://` URLs.
- Added fallback behavior: when a metadata thumbnail fails to load, the modal now
  retries thumbnail rendering via Eagle thumbnail API fetch.

## [2.0.8] - 2026-02-21

### Added

- Obsidian folder to Eagle folder mapping feature in plugin settings.
- Routing utility for deterministic folder matching with longest-prefix priority.
- Unit tests for mapping resolution and upload folder option precedence.

### Changed

- Upload pipeline now resolves target Eagle folder from the active note path.
- Canvas paste upload flow now uses the same mapping/fallback routing logic.

### Fixed

- Prevent duplicate Eagle folder creation under concurrent uploads by sharing in-flight folder resolution.

## [2.0.7] - 2026-02-21

### Added

- Thumbnail grid picker: search results now show image thumbnails in a visual grid
  instead of a text-only fuzzy list. Thumbnails load lazily (6 parallel API calls)
  so the modal opens immediately while previews fill in.
- `EagleUploader.getThumbnailFileUrl(itemId)` — new method that returns the Eagle
  thumbnail as a `file://` URL for display without extra path transformation.
- `styles.css` — dedicated stylesheet for the picker modal grid layout, included
  in CI release artifacts and loaded automatically by Obsidian.

### Fixed

- Korean IME: typing a multi-syllable keyword (e.g. "지혜") no longer dumps the
  partially-composed character into the editor when the search modal closes.
  Fixed by checking `event.isComposing` on Enter and blurring the input before close.

### Changed

- `EagleItemPickerModal` rewritten from `FuzzySuggestModal` to a custom `Modal`
  with a 760px-wide grid, real-time text filter, and lazy thumbnail loading.
- CI `release.yml` now packages and uploads `styles.css` alongside `main.js` /
  `manifest.json`.
- `dev.config.mjs` copies and watches `styles.css` during local development.
- `scripts/verify-plugin.mjs` bug fixes: removed `stdio` array from `execSync`
  options; corrected `typeof` assert comparison from `'"object"'` to `'object'`.

## [2.0.6] - 2026-02-21

### Changed

- Eliminate redundant Eagle thumbnail API call in search+insert flow: `item.filePath`
  from search results is now used directly, reducing API round-trips and failure points.
- Remove runtime monkey-patching of `EagleUploader.upload`; image normalisation
  (`normalizeImageForUpload`) is now called explicitly before upload for better
  type safety and clarity.

### Added

- `EagleUploader.resolveFileUrl(item)` — single entry point for converting an Eagle
  item to a renderable `file://` URL, with fallback to the thumbnail API when
  `filePath` is absent.
- Document Eagle API path contract in `normalizeEagleApiPathToFileUrl` JSDoc.

## [2.0.5] - 2026-02-21

### Fixed

- Normalize Eagle API thumbnail/file paths before generating `file://` URLs to prevent double-encoding issues for non-ASCII filenames during search-import.

## [2.0.4] - 2026-02-21

### Fixed

- Replace unsupported `window.prompt` usage in the Eagle search-import command with an Obsidian modal, fixing search flow on Electron environments that block native prompts.

## [2.0.3] - 2026-02-21

### Added

- Add command **Eagle: Insert image from Eagle (search)** to search Eagle library items and insert selected images into the current note.

## [2.0.2] - 2026-02-14

### Added

- Add configurable fallback format for unsupported image uploads (`jpeg`/`png`/`webp`) and HEIC/other non-renderable format handling.
- Detect image type from file signature/extension before deciding conversion.
- Add conversion quality setting for JPEG fallback output.

### Changed

- Keep existing upload error behavior for conversion failures.

### Fixed

- Improve local image link and file list heuristics for non-standard image extensions in upload paths.

## [2.0.1] - 2026-02-09

### Fixed

- Percent-encode `file://` URLs (spaces/unicode/parentheses) so Obsidian renders embeds reliably.

### Added

- Store Eagle item IDs in markdown alt text (`![eagle:<id>](file://...)`) for portability.
- Commands to re-resolve embedded image paths for the current note or the entire vault.

[2.0.9]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/v2.0.9
[2.0.8]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/v2.0.8
[2.0.7]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/v2.0.7
[2.0.6]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/v2.0.6
[2.0.5]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/v2.0.5
[2.0.4]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/v2.0.4
[2.0.3]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/2.0.3
[2.0.2]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/2.0.2
[2.0.1]: https://github.com/Xia-Ataraxia/obsidian-eagle/releases/tag/2.0.1
