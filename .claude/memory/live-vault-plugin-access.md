---
name: live-vault-plugin-access
description: "Where the user's real vault/plugin lives and how to inspect or drive the running plugin via the Obsidian CLI"
metadata:
  node_type: memory
  type: reference
  originSessionId: 34d5c8f7-00d2-4fba-a8ec-5bb4fe19caa8
  modified: 2026-09-25T16:12:40.299Z
---

- Real vault: `~/Desktop/Bratet's Universe`; plugin installed at `.obsidian/plugins/boox-cloud-sync` (copy `main.js` + `manifest.json` from the repo build to deploy). Sync folder is `99 - Meta/BOOX`, state in `99 - Meta/BOOX/.boox-sync.json`.
- Obsidian caches a plugin's code/version until reload: after deploying run `obsidian plugin:reload id=boox-cloud-sync` (or the user toggles it), otherwise Settings keeps showing the old version.
- The `obsidian` CLI (outdated installer) executes commands but hangs instead of returning output. Run it in the background, `pkill -f "MacOS/obsidian <cmd>"` afterwards, and for `eval` have the code write its result to a file (`app.vault.adapter.write('.obsidian/x.txt', …)` or `require('fs')` into the scratchpad), then read and delete that file.
- `data.json` must not be read (auto-mode denies it as credential access). Plugin state/status is readable via eval (`app.plugins.plugins['boox-cloud-sync'].status`), never dump `session`.
- Useful commands: `obsidian command id=boox-cloud-sync:sync-now`, `obsidian eval code="…"`.
