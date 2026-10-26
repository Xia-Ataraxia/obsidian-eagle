# Eagle Integration

Upload images to Eagle and manage them alongside your vault.

![Pasting an image into a note shows an upload placeholder and progress, then the image renders; the search picker then lists library images and inserts one. Sample images and a stand-in Eagle API on the local machine, not a real library.](https://raw.githubusercontent.com/Xia-Ataraxia/obsidian-eagle/main/docs/assets/demo.webp)

## Features

- Paste or drag images into a note or Canvas and they upload to [Eagle](https://eagle.cool/); a cached copy in your vault renders even when Eagle is closed.
- Duplicate images are reused from Eagle instead of uploaded again.
- Folder mapping routes uploads to Eagle folders by note location (longest matching prefix wins).
- Search your Eagle library with thumbnail previews and insert an image from a command.
- Naming templates (for example `{uuid}_{noteName}`) and a configurable cache folder.

## Usage

1. Start Eagle (3.0 or later) with its local API on, default `localhost:41595`.
2. Paste or drag an image into a note. It uploads to Eagle and a wikilink such as `![[eagle-cache/<id>.jpg]]` is inserted.
3. Run **Insert image from Eagle (search)** to find an existing image, or right-click a local image and choose **Upload to Eagle**.

Missing cache files are restored from Eagle when you open or edit a note, and that note's older `<id>.<ext>` cache links are renamed to `<name>_<id>.<ext>`. The plugin only reads the note you have open, never the whole vault. Deleting an image in Eagle removes its cache copy when you next open a note with it; each image is checked once per session, so restart Obsidian to check again. Links from versions before 2.0 (`![eagle:ID](...)`) still render. If Eagle is closed when you paste, the image is saved to your vault as a regular attachment; right-click it later and choose **Upload to Eagle**. Animated GIFs pasted from the clipboard arrive as static images; drag and drop them instead.

## Installation

Desktop only.

**Community plugins**: open Settings, Community plugins, Browse, search for "Eagle Integration", then Install and Enable.

**Manual**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Xia-Ataraxia/obsidian-eagle/releases/latest) into `<vault>/<configDir>/plugins/eagle/`, then enable the plugin. `<configDir>` is your vault's configuration folder (`.obsidian` by default).

## Disclosures

- **Network use**: the Eagle app's local API at the host and port set in the plugin settings (default `http://localhost:41595`) is contacted to upload, search, and list images. If you point the host at another machine, image data is sent to that machine. No other service is contacted.
- **Account or payment**: Eagle is a separate paid application that you install yourself.
- **Files outside the vault**: none. Cached thumbnails are stored in the vault's cache folder (default `eagle-cache`).
- **Telemetry**: none.

## Development

See the [dev contract](https://github.com/GoBeromsu/obsidian-boiler-template#dev-contract): `bun run dev`, `bun run build`, `bun run ci`.

## License

[MIT](LICENSE)
