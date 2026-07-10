# BOOX Sync (Obsidian plugin)

One-way background sync of your BOOX/Onyx cloud into your Obsidian vault: book
highlights as notes, each notebook as one bound PDF nested in its device
folder hierarchy (`Notebooks/<device folders>/<Title>.pdf` — empty device
folders are mirrored too), calendar memos as bare page images, one folder per
memo day (`Calendar memo/<YYYYMMDD>/<YYYYMMDD>_<page>.png`), and your files
as attachments. Against a backend older than the `pdf` manifest field,
notebooks fall back to per-page images (`<Title>/<Title>_<page>.png`; a
single-page notebook sits directly as `<Title>.png`). BOOX is the source of
truth — the plugin never writes back.

## Build

```bash
cd app/obsidian-plugin
npm install
npm run build      # type-checks, then produces main.js
npm test           # runs the pure-core unit tests
```

## Install into a vault (manual)

Copy three files into `<your-vault>/.obsidian/plugins/boox-sync/`:

- `manifest.json`
- `main.js` (from the build)
- *(no styles.css is required)*

Then in Obsidian: **Settings → Community plugins → enable "BOOX Sync"**.
(Or use [BRAT](https://github.com/TfTHacker/obsidian42-brat) pointed at this repo.)

## Connect

1. **Settings → BOOX Sync → Backend URL** — your deployed app (e.g. `https://boox.example.com`).
2. **Connect** — two ways to get the API key:
   - **Recommended:** log in to the web dashboard, click **Connect Obsidian** — it mints
     a plugin key from your existing session (shown once). Paste it into the modal's
     **API key** field → **Use key**. No email round-trip in Obsidian.
   - Or log in from the modal directly: pick your region → Onyx email → **Send code**
     → type the 6-digit code → **Connect**.
3. Either way the plugin stores a revocable **API key** issued by *your app* (never your
   Onyx password; the Onyx token stays server-side). It syncs on startup, every N minutes,
   and on demand via the command palette (**"BOOX Sync: Sync now"**) or the **Sync now**
   button in settings.

## Notes

- The API key lives in `.obsidian/plugins/boox-sync/data.json`. If you sync your
  vault (iCloud / Obsidian Sync / git), the key travels with it — it is revocable
  via **Disconnect**. Consider git-ignoring `.obsidian/plugins/*/data.json`.
- The plugin only manages files it wrote (tracked in `<sync-folder>/.boox-sync.json`).
  If you edit a synced note, it will not be overwritten — the plugin skips it and
  keeps your version.
