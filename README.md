# BOOX Sync

One-way sync of your BOOX / Onyx cloud into an Obsidian vault. BOOX is the source of
truth — the plugin reads, and never writes back to your device or the cloud.

What lands in your vault:

| Source | Result |
| --- | --- |
| Book highlights | one note per book, with quotes, notes, chapter and page |
| Notebooks | one bound PDF per notebook, inside its device folder hierarchy — `Notebooks/<device folders>/<Title>.pdf` (empty device folders are mirrored too) |
| Calendar memos | one bound PDF per day — `Calendar memo/<YYYYMMDD>.pdf` |
| Files | downloaded as attachments |

If your backend predates the `pdf` manifest field, notebooks and memos fall back to
per-page images (`<Title>/<Title>_<page>.png`, `<YYYYMMDD>/<YYYYMMDD>_<page>.png`; a
single-page notebook sits directly at `<Title>.png`).

## Requires a companion backend

**This plugin does not talk to Onyx directly.** It talks to a companion server that holds
the Onyx session and does the extraction, so you need one running before the plugin can do
anything. It is open source and self-hostable:
**[Bratet/boox-to-obsidian](https://github.com/Bratet/boox-to-obsidian)** (FastAPI + Next.js,
with Docker Compose files for local and production).

Deploy it, sign in with your Onyx account once, then point the plugin at its URL.

## Install

**From Obsidian** — Settings → Community plugins → Browse → search "BOOX Sync".

**Manually** — download `main.js` and `manifest.json` from the
[latest release](https://github.com/Bratet/obsidian-boox-cloud-sync/releases/latest) into
`<your-vault>/.obsidian/plugins/boox-cloud-sync/`, then enable the plugin in Settings →
Community plugins. (No `styles.css` is needed.)

**Pre-release** — point [BRAT](https://github.com/TfTHacker/obsidian42-brat) at this repo.

## Connect

1. **Settings → BOOX Sync → Backend URL** — your deployed backend, e.g. `https://boox.example.com`.
2. **Connect** — two ways to get a key:
   - **Recommended:** sign in to the backend's web dashboard and click **Connect Obsidian**.
     It mints a plugin key from your existing session (shown once). Paste it into the
     modal's **API key** field → **Use key**.
   - Or sign in from the modal: pick your region → Onyx email → **Send code** → type the
     6-digit code → **Connect**.
3. Sync runs on startup, every N minutes, and on demand — the **Sync now** command in the
   palette, or the button in settings.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Backend URL | `http://localhost:8000` | your deployed backend |
| Sync folder | `BOOX` | vault folder to mirror into |
| Sync interval | `30` minutes | `0` disables periodic sync |
| Sync highlights / notebooks / memos / files | all on | pick what you want |
| Delete vault notes removed from BOOX | off | off means your vault keeps a note even after you delete it on the device |

## Network use and data

- The plugin makes network requests to **one host only: the backend URL you configure**.
  Nothing is sent anywhere else, and there is no telemetry.
- Your Onyx credentials never reach the plugin. It stores a revocable **API key issued by
  your own backend**; the Onyx token stays server-side.
- That key lives in `.obsidian/plugins/boox-cloud-sync/data.json`. If you sync your vault
  (iCloud, Obsidian Sync, git), the key travels with it — revoke it any time with
  **Disconnect**, or git-ignore `.obsidian/plugins/*/data.json`.

## Safe by default

The plugin only manages files it wrote, tracked in `<sync-folder>/.boox-sync.json`. Edit a
synced note and it will not be overwritten — the plugin detects the change, skips the file
and keeps your version.

## Develop

```bash
npm install
npm run dev     # watch build
npm run build   # type-check, then bundle to main.js
npm test        # unit tests for the pure core (planner, render, paths, hashing)
```

The sync core is deliberately free of Obsidian APIs — `planSync` is a pure diff over the
manifest and prior state, and vault access goes through the `VaultIO` port — so it is
testable without a running vault.

## License

[MIT](LICENSE)
