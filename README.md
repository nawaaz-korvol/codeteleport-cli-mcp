<div align="center">

# CodeTeleport

**Teleport your AI coding sessions across devices.**

Push a conversation from one machine, pull it on another, resume right where you left off.

[![npm version](https://img.shields.io/npm/v/codeteleport?color=10b981&label=npm)](https://www.npmjs.com/package/codeteleport)
[![License: MIT](https://img.shields.io/badge/license-MIT-10b981)](https://github.com/nawaaz-korvol/codeteleport-mcp/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-10b981)](https://docs.codeteleport.com/getting-started/installation/)
[![Docs](https://img.shields.io/badge/docs-docs.codeteleport.com-10b981)](https://docs.codeteleport.com)

</div>

---

## The Problem

You're deep in a Claude Code session on your work laptop. Time to head home. You close the lid, open your desktop — and that conversation is gone. Start over? Copy files manually? No.

## The Solution

```bash
# On your work machine
codeteleport push

# On your home machine
codeteleport pull
claude --resume
```

That's it. Your full conversation — messages, file history, tool calls, subagents — travels with you. Paths are automatically rewritten to match the new machine.

---

## Quick Start

### 1. Install

```bash
npm install -g codeteleport
```

### 2. Log in

```bash
codeteleport auth login
```

Choose GitHub OAuth or email/password. Takes 10 seconds.

### 3. Push a session

```bash
cd ~/projects/my-app
codeteleport push
```

```
Sessions for my-app (2 found):

  1)  c3a05473    3490 msgs     2 min ago   5.3 MB
  2)  16b4c4d7     847 msgs     3 hours ago 1.2 MB

Select session [1]: 1

Pushing session:
  1)  c3a05473    3490 msgs     2 min ago   5.3 MB

Bundling...
Uploading...
Confirming...

Session teleported to CodeTeleport
  id      : c3a05473-9f12-4a2b-ae27-9478ab66d216
  size    : 5428 KB
  machine : work-laptop
```

### 4. Pull on another machine

```bash
codeteleport pull
```

```
Cloud sessions:

  1)  c3a05473  my-app  work-laptop   3490 msgs   5.3 MB

Select session [1]: 1
Downloading...
Installing...

Session pulled
  id   : c3a05473-9f12-4a2b-ae27-9478ab66d216
  from : work-laptop
  to   : /home/alice/.claude/projects/-home-alice-projects-my-app

Resume with: claude --resume c3a05473-9f12-4a2b-ae27-9478ab66d216
```

### 5. Resume

```bash
claude --resume c3a05473-9f12-4a2b-ae27-9478ab66d216
```

You're back. Full context. Every message, every file edit, every tool call.

---

## MCP Integration

Use CodeTeleport directly inside Claude Code — no terminal needed:

```bash
claude mcp add codeteleport -- codeteleport-mcp
```

Then just say:

> *"Push this session to the cloud"*
>
> *"Pull my latest session"*
>
> *"Show me my local sessions"*

Six tools available: `teleport_push`, `teleport_pull`, `teleport_list`, `teleport_local_list`, `teleport_status`, `teleport_delete`.

---

## CLI Commands

| Command | Description |
|---|---|
| `codeteleport auth login` | Log in (GitHub OAuth or email) |
| `codeteleport push` | Push a session to the cloud |
| `codeteleport pull` | Pull a session from the cloud |
| `codeteleport list` | List local or cloud sessions |
| `codeteleport status` | Account info, plan, usage |
| `codeteleport delete` | Delete a cloud session |

Every command is interactive — smart defaults, session pickers, confirmation prompts.

---

## What Gets Teleported

Everything your AI coding agent stores for the conversation:

| Component | Description |
|---|---|
| Conversation log | Every message, tool call, and response (JSONL) |
| Subagent conversations | Background agent logs |
| File history | Snapshots of files read or edited |
| Paste cache | Content pasted into the conversation |
| Shell snapshots | Terminal state during the session |

All bundled into a compressed `.tar.gz`, uploaded to secure cloud storage, and restored with automatic [path rewriting](https://docs.codeteleport.com/concepts/path-rewriting/) on the target machine.

---

## Free & Open Source

The CLI and MCP server are fully open source under the MIT license. The cloud sync service has a generous free tier (25 sessions, 3 devices) — no credit card required. See [pricing](https://codeteleport.com/#pricing) for Pro plans.

---

## Platform Support

| Platform | Status |
|---|---|
| macOS | Fully supported |
| Linux | Fully supported |
| Windows | Not yet (planned) |

---

## Links

| | |
|---|---|
| **Documentation** | [docs.codeteleport.com](https://docs.codeteleport.com) |
| **Dashboard** | [app.codeteleport.com](https://app.codeteleport.com) |
| **Website** | [codeteleport.com](https://codeteleport.com) |
| **npm** | [codeteleport](https://www.npmjs.com/package/codeteleport) |
| **GitHub** | [nawaaz-korvol/codeteleport-mcp](https://github.com/nawaaz-korvol/codeteleport-mcp) |

---

## License

MIT
