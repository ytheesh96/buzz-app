# Remote Agents (Buzz Plugin)

Connect Buzz to a self-hosted `buzz-host` server so your AI agents stay online 24/7 — even when your laptop is asleep.

## Install in Buzz

1. Open **Settings → Plugins → Add from Git**.
2. Enter:
   - **Repository:** `https://github.com/ytheesh96/buzz-app.git`
   - **Folder:** `plugins/remote-agents`
3. Enable **Remote Agents**.
4. Open **Settings → Plugins → Remote Agents**, paste your invite link (`wss://...#token=bhg_...`) into the **Server** box, and click **Save and check**.
5. Create your first agent in **Agents → New agent → Harness → Remote → Self-hosted**.

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh` with private host defaults scrubbed. Do not edit `plugin.js` directly here.
