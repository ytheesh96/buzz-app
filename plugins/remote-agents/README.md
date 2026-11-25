# Remote Agents

Run AI agents on your own Linux or macOS machines (`buzz-host`), so they keep
answering while this computer is off.

## Getting started

1. Run `buzz-host` on a Linux or macOS machine. Machines with an authorized
   agent on your relay are discovered automatically over Nostr and connect via
   Iroh (with `wss://` fallback).
2. Open **Settings → Agent setup → Harness defaults → Self-hosted** to manage
   connected machines or paste an invite/pairing link (`wss://...#token=...`).
3. In **Agents**, choose **New agent**, pick your machine under **Run on**,
   and select its **Harness** (Claude Code, Codex, Hermes, or Antigravity).

---

## Install from Git (other Buzz builds)

1. Open **Settings → Plugins → Add from Git**.
2. Enter repository `https://github.com/ytheesh96/buzz-app.git` and folder
   `plugins/remote-agents`.
3. Enable **Remote Agents** and connect your `buzz-host` server.

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh` with private host defaults scrubbed. Do not edit `plugin.js` directly here.
