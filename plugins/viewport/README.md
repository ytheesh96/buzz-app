# Viewport (Buzz Plugin)

Live remote desktop preview, in-app Viewport page, and takeover controls for self-hosted agents on a `buzz-host` server.

## Install in Buzz

1. Install and connect **Remote Agents** (`plugins/remote-agents`) with your server URL or invite link first.
2. Open **Settings → Plugins → Add from Git**.
3. Enter:
   - **Repository:** `https://github.com/ytheesh96/buzz-app.git`
   - **Folder:** `plugins/viewport`
4. Enable **Viewport** — it automatically reuses the server connection and invite token saved by **Remote Agents**.
5. Open **Viewport** from the app dock (or open your self-hosted agent's **Desktop** tab) to enable and view its remote desktop inside Buzz (requires an admin connection or a trusted guest invite with remote desktop enabled).

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh` with private host defaults scrubbed. Do not edit `plugin.js` directly here.
