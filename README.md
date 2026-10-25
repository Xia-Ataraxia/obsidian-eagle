# Eagle Integration

![Downloads](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&query=%24%5B%27eagle-plugin%27%5D.downloads&suffix=%20downloads&logo=obsidian&label=Obsidian&color=483699)
![Latest Release](https://img.shields.io/github/v/release/Xia-Ataraxia/obsidian-eagle?logo=github)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

Paste images into Obsidian notes and they're automatically uploaded to [Eagle](https://eagle.cool/) — your dedicated media manager. Keep your vault lean, your Eagle library rich, and your images searchable.

## Why Eagle Integration?

Your Obsidian vault is for text. Eagle is for images. This plugin bridges them seamlessly:

- **Paste once, organize with Eagle** — paste screenshots, clips, or photos; they auto-upload to Eagle and render in your notes via local cache
- **Keep your vault small** — stop bloating your vault with embedded image files; store everything in Eagle instead
- **Search-friendly** — search your Eagle library without leaving Obsidian; insert images with a single search
- **Works offline** — cached thumbnails render even if Eagle isn't running

## Features

- ⚡ **Instant paste upload** — paste or drag images directly into notes; auto-upload to Eagle
- 🎨 **Canvas support** — upload images in Obsidian Canvas views
- 🔍 **Smart deduplication** — same image pasted twice? Reused from Eagle instead of re-uploading
- 📂 **Folder mapping** — route uploads to different Eagle folders based on your note location
- 🖼️ **Visual search** — browse your entire Eagle library with thumbnail previews and instant insert
- 💾 **Offline rendering** — images cached locally in your vault; work without Eagle running
- ⚙️ **Naming templates** — customize how images are named in Eagle (e.g., `{uuid}_{noteName}`)
- 🔄 **Cache sync** — missing cache files auto-restore on startup and tab switch
- 🗑️ **Smart cleanup** — delete an image in Eagle and the cache copy evicts automatically
- 🔙 **Backward compatible** — old-format Eagle links still render; migration command available

## Requirements

- **Eagle 3.0+** installed and running (https://eagle.cool/)
- **Desktop only** — Obsidian on Mac, Windows, or Linux (uses Electron APIs)
- Eagle's local API enabled (default: `localhost:41595`)

## Installation

### Community Plugins (Recommended)

1. Open **Settings > Community plugins**
2. Search for **Eagle Integration**
3. Click **Install** and then **Enable**

### Manual Installation

```bash
cd <your-vault>/.obsidian/plugins
git clone https://github.com/Xia-Ataraxia/obsidian-eagle eagle-plugin
cd eagle-plugin
bun install && bun run build
cp dist/* .
```

Restart Obsidian and enable the plugin under **Settings > Community plugins**.

## Quick Start

1. Make sure Eagle is running
2. Open any note in Obsidian
3. Paste or drag an image into the editor

That's it. The plugin uploads to Eagle, caches the image in `eagle-cache/`, and inserts a wikilink:

```markdown
![[eagle-cache/LXXXXXXXXXXXXXXX.jpg]]
```

The image renders immediately — no folders to manage, no file paths to remember.

## Commands

| Command | Shortcut | Action |
|---------|----------|--------|
| **Eagle: Upload to Eagle** | — | Upload the local image at your cursor |
| **Eagle: Insert image from Eagle** | — | Search Eagle and insert a selected image |
| **Eagle: Migrate all images to eagle-cache** | — | Convert old-format `![eagle:ID](...)` links to wikilinks |

Right-click a local image to access **Upload to Eagle** from the context menu.

## Configuration

### Basic Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| **Eagle API Host** | `localhost` | Host of your running Eagle instance |
| **Eagle API Port** | `41595` | Port of your Eagle instance |
| **Default Eagle Folder** | _(empty)_ | Target folder in Eagle; leave empty for root |
| **Cache Folder** | `eagle-cache` | Vault folder for thumbnails; supports nesting (e.g., `80. References/Eagle`) |
| **Fallback Format** | `jpeg` | Format for unsupported image types (HEIC, etc.) |
| **JPEG Quality** | `0.9` | Compression quality for JPEG fallback (0.0–1.0) |

### Folder Mapping

Route uploads to different Eagle folders based on your note's location. Add rules under **Settings > Eagle Plugin Settings > Folder Mapping**. The **longest matching prefix wins**.

**Example:**

| Obsidian Folder | Eagle Folder |
|---|---|
| `Projects/Design` | `Design` |
| `Projects` | `Projects` |
| `(root)` | `Misc` |

A note at `Projects/Design/wireframe.md` uploads to the `Design` Eagle folder. A note at `Projects/research.md` uploads to `Projects`. Everything else goes to `Misc`.

### Cache Management

All embedded images are stored as wikilinks pointing to your local cache:

```markdown
![[eagle-cache/LXXXXXXXXXXXXXXX.jpg]]
```

On startup and tab switch, missing cache files are backfilled from Eagle. If you delete an image in Eagle, its cache copy evicts on the next sync.

**To rename the cache folder:**

1. Update **Cache Folder** in settings
2. Confirm the prompt — the plugin moves all cached files and updates wikilinks automatically

## Migrating from Old Format

Versions prior to 2.0 used this format:

```markdown
![eagle:LXXXXXXXXXXXXXXX](file:///absolute/path/to/image.jpg)
```

Run **Eagle: Migrate all images to eagle-cache** to convert all old-format links to wikilinks. Old-format links continue to render for backward compatibility.

## Network access

The plugin makes HTTP requests only to the Eagle app's local API at the host and port configured in settings (default `http://localhost:41595`) to upload, search and list images. If you point the host at another machine, image data is sent to that machine. No telemetry, no other external services.

## Development

```bash
bun install
bun run dev       # esbuild watch into dist/
bun run build     # Production build into dist/
bun run ci        # Build + typecheck + lint + test
```

Releases are CI-only (`bun run release <patch|minor|major>` opens a version-bump PR).

## FAQ

**Q: Is my data secure?**
A: All images remain on your machine in Eagle's local library. The plugin's only network access is HTTP requests to the Eagle app's local API (default `localhost:41595`, configurable host and port in settings). Nothing is sent to external servers.

**Q: Can I undo an accidental upload?**
A: Yes — delete it from Eagle directly. On the next tab switch, the plugin detects the deletion and removes the cache file.

**Q: Do images render if Eagle is offline?**
A: Yes — images are cached in your vault as standard Obsidian wikilinks and render regardless of Eagle's status.

**Q: Can I upload videos?**
A: Currently the plugin focuses on image uploads. Video support may come in future releases.

**Q: Can I bulk-upload my existing vault images to Eagle?**
A: Not yet. You can migrate individual images using the **Upload to Eagle** command, or use Eagle's built-in import features.

## Known Limitations

- Animated GIFs pasted from clipboard are captured as static images by the OS. Use drag-and-drop for animated GIFs.
- Eagle must be running for uploads and cache sync; rendering always works via local cache.

## Credits

- Originally forked from [gavvvr/obsidian-imgur-plugin](https://github.com/gavvvr/obsidian-imgur-plugin)
- Adapted for Eagle integration and expanded with folder mapping, thumbnail search, and cache management

## Contributing

Contributions welcome. Please open an issue or discussion before starting work on large changes.

For questions or suggestions, use [GitHub Discussions](https://github.com/Xia-Ataraxia/obsidian-eagle/discussions).

## License

MIT

---

If this plugin saves you time, consider giving it a star on GitHub. Made with care for Obsidian users who care about their media library.
