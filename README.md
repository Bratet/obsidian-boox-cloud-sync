# BOOX Notes Sync

Import the notebooks, calendar memos and book highlights from your BOOX (Onyx) e-ink tablet into your Obsidian vault. Handwriting becomes PDFs or PNG pages, highlights become Markdown notes. Everything is decoded and rendered inside the plugin: no companion app, server or API key.

Sync is one-way. The plugin never changes anything on your tablet or in your BOOX account.

This is an independent project, not affiliated with Onyx International or BOOX.

## What you get

| BOOX content | Default location in the vault |
| --- | --- |
| Notebooks | `BOOX/Notebooks/<device folders>/<Title>.pdf` |
| Calendar memos | `BOOX/Calendar memo/<YYYYMMDD>.pdf` |
| Book highlights and annotations | `BOOX/Highlights/<Book>.md`, with quotes, notes, chapters and pages |
| Attachments uploaded to the BOOX cloud (cloud source only) | `BOOX/Files/<Filename>` |

Pages keep the device order, and notebooks keep their device folders, including empty ones. Rendering covers pen pressure, colors, moved, resized and erased strokes, and infinite canvases. PDF pages are lossless 226 DPI images. Handwriting is not converted to searchable text, and page templates and backgrounds are not drawn.

## Choose a source

The plugin reads your notes from one of two places. Pick it under **Settings → BOOX Notes Sync → Read notes from**.

| | **This tablet** | **BOOX cloud** |
| --- | --- | --- |
| Where the plugin runs | Obsidian for Android on the BOOX tablet | Obsidian on any computer |
| Account needed | None | BOOX account with cloud sync on |
| Network use | None | BOOX servers and BOOX's Alibaba OSS storage |
| Notes that never uploaded | Included | Missing |
| Cloud attachments | Not available | Included |
| Reaching your other devices | Through your vault sync (Obsidian Sync or similar) | Through your vault sync, from the one connected device |

### This tablet

**Pros**
- Gets everything on the tablet. The BOOX cloud only has what the tablet managed to upload, and the BOOX calendar app silently skips some memos and never retries them.
- No login, no network: your notes never leave the tablet except through your own vault sync.
- Fresh as soon as you switch back to Obsidian.

**Cons**
- Obsidian has to be installed and running on the BOOX tablet, with **All files access** granted.
- BOOX's app freezing stops Obsidian, and the plugin with it, in the background.
- No cloud attachments.
- It reads the BOOX apps' private on-device databases. A BOOX firmware update can change their format. Tested on a Note Air5 C with firmware 4.2.1.

### BOOX cloud

**Pros**
- Runs on a computer. Nothing to install on the tablet.
- Includes attachments you uploaded to the BOOX cloud.

**Cons**
- Needs a BOOX account, and BOOX cloud sync turned on on the tablet.
- Only has what the tablet uploaded. Missed uploads, calendar memos in particular, never show up.
- Uses BOOX's private cloud API, which BOOX can change without notice. BOOX also expires sessions from time to time, and you then sign in again with an email code.

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **BOOX Notes Sync**, then install and enable it.

To install by hand, download `main.js` and `manifest.json` from the [latest release](https://github.com/Bratet/obsidian-boox-cloud-sync/releases/latest) into `<your vault>/.obsidian/plugins/boox-cloud-sync/`, then enable the plugin under **Community plugins**.

Requires Obsidian 1.13.0 or newer. Older Obsidian versions are offered release 1.0.1.

## Set up: this tablet

1. Install Obsidian from the Play Store on the BOOX tablet and open your vault.
2. In Android settings, give Obsidian **All files access**. The BOOX apps keep notes in the hidden `.ksync` folder of the tablet's shared storage, outside the vault.
3. In BOOX **Settings → Apps & Notifications → Freeze Settings**, keep Obsidian unfrozen.
4. Install and enable this plugin. On Android, **This tablet** is the default source.

The plugin reads the tablet when Obsidian starts, every sync interval, and whenever Obsidian comes back to the foreground.

Run it on the tablet only. If your vault sync also copies plugins and their settings to your other devices (Obsidian Sync does), the plugin stays idle on them: computers never read the tablet source, and an Android phone without BOOX notes skips it quietly (only **Sync now** reports why). The exports arrive through vault sync. Don't change the source on another device: the change syncs back to the tablet.

## Set up: BOOX cloud

1. On the tablet, turn on BOOX cloud sync and let it finish uploading.
2. Open **Settings → BOOX Notes Sync**, set **Read notes from** to **BOOX cloud**, and select **Connect**.
3. Pick the region your tablet uses: **Europe** or **Global**.
4. Enter your BOOX account email, select **Send code**, enter the six-digit code, then select **Connect and sync**.

The session is kept in your system keychain through Obsidian's secret storage, so syncing resumes after a restart. **Disconnect** removes it; your exported files stay.

Connect on one device per vault. The keychain session isn't copied by vault sync, so your other devices stay idle and receive the exports through vault sync. Two connected devices would both write the same files, and vault sync could create conflict copies.

## Syncing

- Sync runs every 15 minutes while Obsidian is open. Set **Sync interval** to `0` to turn this off.
- **Sync on startup** runs a sync a few seconds after Obsidian opens.
- The **Sync now** command and button run one immediately.
- Unchanged notebooks and memos are skipped. When one changes, only that one is rendered again, and the sync notice names it.
- Turn content types on or off: **Book highlights**, **Notebooks**, **Calendar memos**, **Attachments**.

## Folders and file names

Category folders are relative to **Sync folder** and can contain subfolders. Turn off **Keep device folder hierarchy** to put all notebooks in one folder. **Handwriting format** switches between one **PDF** per notebook or memo and individual **PNG** pages.

File extensions are added automatically. Name templates:

| Setting | Default | Placeholders |
| --- | --- | --- |
| Notebook name | `{title}` | `{title}`, `{id}`, `{date}` (last update, UTC) |
| Highlights note name | `{title}` | `{title}`, `{id}` |
| Memo name | `{date}` | `{date}`, `{id}`, `{title}` |
| Attachment name | `{title}` | `{title}` without extension, `{id}`, `{ext}` |
| PNG page name | `{title}_{page}` | `{title}`, `{id}`, `{page}` |
| Date format | `YYYYMMDD` | `YYYY`, `MM`, `DD`, for example `YYYY-MM-DD` |

For example, notebook name `{date} - {title}` with date format `YYYY-MM-DD` gives `2026-09-20 - Meeting notes.pdf`. A one-page PNG notebook uses the notebook name directly; longer notebooks get a folder of pages. PNG memos always get a folder.

Names are made safe for every platform. Two notebooks or memos with the same name get an ID suffix, and two books or attachments with the same name get a short hash suffix. Templates that would make two items write the same file stop the sync with a message instead of overwriting.

**Highlight block template** replaces the default quote callouts. It uses `{quote}`, `{note}`, `{chapter}`, `{page}` and `{id}`, and is repeated for each highlight. Leave it empty for the default.

Changes to names and formats apply at the next sync, and unchanged files move to their new paths. Changing **Sync folder** starts a new copy and leaves the old folder alone.

## Your files are safe

- `<sync folder>/.boox-sync.json` records which files the plugin wrote, with checksums. A file you edited is never overwritten; the sync notice counts it as **kept**.
- Files the plugin didn't write are never touched.
- **Remove files deleted from BOOX** is off by default. When on, it only removes unchanged files the plugin wrote, and only removes folders once they're empty.
- A sync folder already used for another BOOX account is refused.
- Failed downloads, incomplete cloud listings and damaged handwriting stop that item instead of producing an empty or partial export. All pages of an item are ready before its file is replaced, and each finished item is recorded before the next one starts.
- Vault sync doesn't copy `.boox-sync.json`, so a device syncing for the first time finds earlier exports it hasn't recorded. It takes over a PDF at an export path only if this plugin produced it (PDF producer `BOOX Sync`), and copies the original to `<sync folder>/.boox-sync-replaced/<time>/` first. Any other file at that path is kept and reported.

## Privacy and network use

- **This tablet**: no network requests. The plugin reads the BOOX apps' files in the tablet's `.ksync` folder, outside the vault. That is why it needs Android's **All files access**.
- **BOOX cloud**: the plugin talks to the BOOX server for your region (`eur.boox.com` or `push.boox.com`) to sign in and list your notes, and downloads note files from BOOX's Alibaba OSS storage. Nothing is sent anywhere else.
- No telemetry, no third-party services.
- The BOOX session token is kept in Obsidian's secret storage (your system keychain), never in the plugin's `data.json`, so vault sync and backups don't copy it. Your account email and ID, and the plugin's preferences, are stored in `data.json`. Other plugins running in Obsidian can read secret storage.

## Development

Use Node.js 22.13 or newer; the SQLite reader tests use `node:sqlite`.

```sh
npm ci
npm run build       # type-check and bundle main.js
npm test            # sync, protocol, rendering, naming and session tests
npm run lint        # Obsidian's review rules (eslint-plugin-obsidianmd)
npm run test:smoke  # settings and sign-in flow in a browser harness, plus real canvas rendering
npm run dev         # watch build
```

The smoke test uses Microsoft Edge by default. Set `BOOX_TEST_BROWSER=chrome` or `BOOX_TEST_BROWSER=chromium` to use another browser. It uses made-up account responses and a minimal stand-in for Obsidian. Screenshots go to the ignored `.vault-test/` folder.

`src/__fixtures__/handwriting.json` is synthetic and contains no user data.

Pushing a tag that equals the `manifest.json` version runs `.github/workflows/release.yml`, which tests, builds and publishes `main.js` and `manifest.json` as a GitHub release.

### Tested with

- **BOOX cloud**: desktop Obsidian 1.13.7, September 20, 2026. All 74 notebooks, memos and attachments of a BOOX account were processed: 68 exported, 6 empty ones skipped, no errors.
- **This tablet**: Note Air5 C, firmware 4.2.1, Obsidian 1.12.7 for Android, October 27, 2026. The plugin's database readers matched SQLite's own results on all 46 BOOX databases on the device, every page parsed, and memos that had never reached the BOOX cloud were exported.

Other BOOX models, firmware versions and regions may behave differently.

Storage requests are signed following [Alibaba OSS's signature format](https://www.alibabacloud.com/help/en/oss/include-signatures-in-the-authorization-header). PDFs are built with [pdf-lib](https://pdf-lib.js.org/).

## License

[MIT](LICENSE)
