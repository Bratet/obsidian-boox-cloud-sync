# BOOX Sync

Sync BOOX / Onyx cloud directly into an Obsidian vault. **No web app, companion server, Python installation, or backend API key is required.** Handwriting decoding, rendering, PDF creation, and file naming run inside the plugin. Sync is one-way: it does not change your tablet or BOOX cloud.

## What is imported

| Source | Default output |
| --- | --- |
| Book highlights and annotations | `BOOX/Highlights/<Book>.md`, with quotes, notes, chapters and pages |
| Notebooks | `BOOX/Notebooks/<device folders>/<Title>.pdf` |
| Calendar memos | `BOOX/Calendar memo/<YYYYMMDD>.pdf` |
| Cloud attachments | `BOOX/Files/<Filename>` |

Notebook folders, including empty folders, are preserved. Notebook and memo pages follow device order. Handwriting rendering handles pressure, colors, moved/resized strokes, erased strokes, cross-tile references, older page models, newer tile-based notebooks, and cropped infinite canvases. PDF pages embed lossless PNGs at 226 DPI. As with the previous backend, handwriting is rendered as images rather than searchable OCR; templates/backgrounds and every proprietary BOOX object type are not reproduced.

## Install this version

This is the standalone **0.3.3** source build; a release has not been published automatically.

1. Run `npm ci` and `npm run build` in this repository.
2. Create `<your-vault>/.obsidian/plugins/boox-cloud-sync/`.
3. Copy `main.js` and `manifest.json` there. No `styles.css` is needed.
4. Enable BOOX Sync in Obsidian's Community plugins settings, or reload it after replacing the files.

Requires desktop Obsidian 1.11.4 or newer. The plugin inherits Obsidian's controls and theme.

## Connect directly to BOOX

1. Enable BOOX cloud sync on your tablet and let it finish uploading.
2. Open **Settings → BOOX Sync → Connect**.
3. Select the same region as the tablet: **Europe** or **Global**.
4. Enter your BOOX account email, send a code, and enter the six-digit code.
5. Select **Connect and sync**.

The connection is saved in your system keychain through Obsidian's secret storage, so sync resumes by itself after Obsidian restarts. There's no passphrase. Sync runs every 15 minutes by default while Obsidian is open; **Sync now** runs on demand, and `0` minutes disables scheduled runs. **Sync on startup** controls the run shortly after Obsidian opens.

Notebooks and memos whose cloud content hasn't changed are skipped without rendering. When an already-synced doc changes on the tablet, only that doc is re-rendered, and the sync notice names it.

**Disconnect** removes the saved connection from the keychain; it does not delete local exports or revoke other BOOX sessions. If BOOX expires the session, connect again with a new email code.

Upgrading from 0.3.x, where the connection was locked with a passphrase: select **Finish upgrade** in settings and enter the old passphrase one last time. The connection then moves to the keychain.

## Customize folders and filenames

All category folders are relative to **Sync folder** and may include subfolders. Switch **Keep device folder hierarchy** off to flatten notebooks. Choose one bound **PDF** per notebook/memo or individual **PNG** pages.

File extensions are automatic. Filename templates support:

| Setting | Default | Available placeholders |
| --- | --- | --- |
| Notebook name | `{title}` | `{title}`, `{id}`, `{date}` (last update, UTC) |
| Highlights note name | `{title}` | `{title}`, `{id}` |
| Memo name | `{date}` | `{date}`, `{id}`, `{title}` |
| Attachment name | `{title}` | `{title}` without extension, `{id}`, `{ext}` |
| PNG page name | `{title}_{page}` | `{title}`, `{id}`, `{page}` |
| Date format | `YYYYMMDD` | `YYYY`, `MM`, `DD`; e.g. `YYYY-MM-DD` |

For example, notebook name `{date} - {title}` and date format `YYYY-MM-DD` produce `2026-09-20 - Meeting notes.pdf`. A memo without cloud date metadata uses its ID until the date becomes available. A single-page PNG notebook uses its notebook name directly; multi-page notebooks use a folder containing the configured page names. PNG memos always use a folder.

Names are sanitized for Obsidian and Windows. Duplicate notebook/memo names receive an ID suffix; duplicate book and attachment names receive a stable hash suffix. Conflicting templates stop the sync with a message rather than overwrite a file. Include `{page}` in PNG page names.

The **Highlight block template** can replace the default quote callouts using `{quote}`, `{note}`, `{chapter}`, `{page}`, and `{id}`. It is repeated for each highlight; the book title and BOOX frontmatter remain. Leave it empty to restore default formatting.

Naming and export changes apply at the next sync. Previously managed, unchanged files move to the new paths. Changing the top-level **Sync folder** starts a separate mirror and keeps the old folder intact.

## Local storage and privacy

The plugin contacts the selected BOOX host (`eur.boox.com` or `push.boox.com`) and BOOX's Alibaba OSS storage endpoints over HTTPS. It does not contact a companion service or send telemetry. Your account still uses BOOX cloud; this is not an offline tablet connection.

The BOOX session token is stored in Obsidian's secret storage (the operating system keychain), never in `data.json`, so vault sync and backups don't copy it. Account email, account ID, and ordinary preferences are stored unencrypted in `data.json`. Secret storage does not isolate the session from other code running inside Obsidian.

Temporary BOOX storage credentials and downloaded rendering blobs stay in memory for a sync run. Handwriting files download in batches of up to four; duplicate requests share one download. The raw blob cache is bounded at 32 MiB and evicts the least recently used entries. PDF pages are compressed as they are added so decoded images can be released before rendering the next page. Large PDFs still require memory proportional to their compressed embedded pages and the current page's working buffers.

## Safe updates and migration from 0.2.x

Old backend URL/API-key settings are removed on first load. **Sign in directly again.** Your old server and its stored credentials are not contacted or deleted by this plugin; retire that deployment separately if you no longer use it.

An older direct-cloud build may have saved a plaintext `token`. On upgrade, the plugin immediately removes that field from disk and keeps the connection in memory for the current run. Use **Remember connection** to save it encrypted before closing Obsidian.

The existing `<sync-folder>/.boox-sync.json` tracks managed files. Markdown exports are checked for edits; new binary exports also receive SHA-256 checksums. Edited files and unrelated files at a destination are kept. **Remove files deleted from BOOX** is off by default and only removes unchanged managed files. A tracked folder is removed only when empty. Sync refuses to reuse a folder recorded for another BOOX account.

Old binary exports have no recorded checksum. When the plugin cannot prove they match, it reports them as **kept (edited or unverified)**. To migrate those, choose a new sync folder (the safest option), or move the old files you want to keep out of their managed locations and sync again. Do not delete the sync state as a conflict-resolution shortcut.

Incomplete cloud listings, corrupt handwriting, and failed downloads stop the affected work instead of masquerading as deleted/empty content. Only pages positively identified as having no remaining ink are omitted from an export. All pages of an item are downloaded before its files are replaced. Completed items are checkpointed before the next item starts. If a later write fails, completed writes retain their checksums and the item remains pending, so retries can distinguish partial plugin output from user edits. Multi-file writes are not a filesystem transaction; abrupt termination during an item can still leave unrecorded files.

## Development and verification

Use Node.js 22 LTS or 24 LTS for development.

```sh
npm ci
npm run build       # type-check and bundle main.js
npm test            # pure sync, protocol, rendering, naming, and credential tests
npm run test:smoke  # browser settings/login harness + real Canvas PNG pixel checks
npm run dev         # watch build
```

The smoke test uses installed Microsoft Edge by default; set `BOOX_TEST_BROWSER=chrome` to use Chrome. It uses synthetic account responses and a minimal Obsidian control harness, not a real Obsidian account. Screenshots are written to ignored `.vault-test/`.

`src/__fixtures__/handwriting.json` was generated with the old backend's synthetic fixture builders, without user data. Tests cover page ordering, erased and transformed strokes, canvas bounds, PDF binding, paginated cloud reads, credential encryption, naming changes, and protection of local edits, including edits made while downloads are running.

Live checks on September 20, 2026 in desktop Obsidian 1.13.7 successfully read a BOOX account's inventory and processed all 74 available notebooks, memos and attachments: 68 exports/downloads succeeded and six empty items were skipped, with zero errors. These were read-only cloud/export checks; they did not replace the user's existing vault exports. The installed plugin's plaintext-session migration was also verified. Other BOOX devices and regions may behave differently, and BOOX's private cloud formats may change.

Protocol/rendering behavior was ported from `../boox-to-obsidian` (`boox_sync/` and `app/backend/manifest.py`, `render.py`). Storage signing follows [Alibaba OSS's documented signature format](https://www.alibabacloud.com/help/en/oss/include-signatures-in-the-authorization-header); local PDF binding uses [pdf-lib](https://pdf-lib.js.org/docs/api/classes/pdfdocument).

## License

[MIT](LICENSE)
