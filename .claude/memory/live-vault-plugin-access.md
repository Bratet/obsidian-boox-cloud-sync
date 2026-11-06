---
name: live-vault-plugin-access
description: "Where the user's real vault/plugin lives and how to inspect or drive the running plugin via the Obsidian CLI"
metadata:
  node_type: memory
  type: reference
  originSessionId: 34d5c8f7-00d2-4fba-a8ec-5bb4fe19caa8
  modified: 2026-09-25T16:12:40.299Z
---

- Real vault (Linux desktop `cendre`): `~/Documents/Bratet's Universe`; plugin at `.obsidian/plugins/boox-cloud-sync` (copy `main.js` + `manifest.json` from the repo build to deploy). Sync folder is `99 - Meta/BOOX`, state in `99 - Meta/BOOX/.boox-sync.json`.
- Since 2026-11 the plugin runs only on the BOOX tablet (source "tablet"); the desktop copy stays idle and gets exports via Obsidian Sync. Syncthing and the folder source are gone.
- Tablet (Note Air5 C, adb serial `ad04ff7b`, authorized): `~/.local/opt/platform-tools/adb`. Vault on device: `/storage/emulated/0/Documents/Bratet's Universe`. Deploy with `adb push main.js manifest.json "<vault>/.obsidian/plugins/boox-cloud-sync/"`, then restart Obsidian (`adb shell am force-stop md.obsidian`, then open it). MTP fallback: `gio mount mtp://ONYX_LAGOON-MTP__SN%3AE032087A_ad04ff7b/`.
- Obsidian caches a plugin's code until reload. The desktop `obsidian` CLI is disabled (Settings → General → Advanced); without it, the user restarts Obsidian or toggles the plugin.
- `data.json` must not be read (auto-mode denies it as credential access). Plugin state/status is readable via eval (`app.plugins.plugins['boox-cloud-sync'].status`), never dump `session`.
- Useful commands: `obsidian command id=boox-cloud-sync:sync-now`, `obsidian eval code="…"`.
