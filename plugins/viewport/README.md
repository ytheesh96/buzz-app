# Viewport

See and control the desktop of a self-hosted agent directly inside Buzz. Needs
**Remote Agents**.

## Getting started

1. Open a self-hosted agent and go to the **Desktop** tab.
2. Turn on **Desktop**. The agent gets its own virtual Linux desktop on your
   `buzz-host` machine, separate from your screen.
3. Open **Viewport** from the app dock (or choose **Open desktop**) to watch
   and control it inside Buzz.

---

## Install from Git (other Buzz builds)

1. Install and connect **Remote Agents** (`plugins/remote-agents`) first.
2. Open **Settings → Plugins → Add from Git**.
3. Enter repository `https://github.com/ytheesh96/buzz-app.git` and folder
   `plugins/viewport`.
4. Enable **Viewport** — it reuses the server connection saved by **Remote Agents**.

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh` with private host defaults scrubbed. Do not edit `plugin.js` directly here.
