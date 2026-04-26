# Jarvis — Personal Agentic AI Companion

<div align="center">

![Jarvis](https://img.shields.io/badge/Jarvis-Agentic%20AI%20Companion-6C3CE4?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)
![Electron](https://img.shields.io/badge/Electron-41-47848F?style=for-the-badge&logo=electron)
![React](https://img.shields.io/badge/React%20%2B%20Ink-Terminal%20%26%20GUI-61DAFB?style=for-the-badge&logo=react)
![Python](https://img.shields.io/badge/Python-GPT--OSS%20Bridge-3776AB?style=for-the-badge&logo=python)
![VRAM](https://img.shields.io/badge/Target%20VRAM-8GB-FF6B35?style=for-the-badge)

</div>

---

> **Jarvis** is a personal agentic AI companion built on top of the Claude Code CLI source. It extends the upstream foundation with a fully engineered tool kit, a buddy companion system, AutoDream background memory consolidation, session memory management, a Google Drive–style brain, a remote GPT-OSS bridge for offloading reasoning to powerful GPU servers, a native Electron desktop shell, and an 8 GB VRAM–optimized local inference path via Qwen and Ollama.

---

## Table of Contents

- [What is Jarvis vs. the Original](#what-is-jarvis-vs-the-original)
- [Key Additions & Changes](#key-additions--changes)
  - [Buddy Companion System](#1-buddy-companion-system)
  - [AutoDream — Background Memory Consolidation](#2-autodream--background-memory-consolidation)
  - [Memory Management (memdir)](#3-memory-management-memdir)
  - [Session Memory](#4-session-memory)
  - [Magic Docs](#5-magic-docs)
  - [Remote GPT-OSS Bridge (Qwen × Claude)](#6-remote-gpt-oss-bridge-qwen--claude)
  - [Native Electron Desktop Shell](#7-native-electron-desktop-shell)
  - [Thunder Automation Panel](#8-thunder-automation-panel)
  - [Google Drive Brain (DriveSetupWizard)](#9-google-drive-brain-drivesetupwizard)
  - [Jarvis Branding & Build Pipeline](#10-jarvis-branding--build-pipeline)
  - [Expanded Tool Kit](#11-expanded-tool-kit)
  - [Voice Mode](#12-voice-mode)
  - [8 GB VRAM Local Inference Path](#13-8-gb-vram-local-inference-path)
- [Architecture Overview](#architecture-overview)
- [Directory Structure](#directory-structure)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Original Source Reference](#original-source-reference)

---

## What is Jarvis vs. the Original

The upstream project is the **Claude Code CLI** (Anthropic) — a terminal-based AI development environment (`@anthropic-ai/claude-code-source`). It provides a rich agentic coding loop with 46+ tools, MCP protocol support, bridge-based remote sessions, and a React/Ink terminal UI.

**Jarvis** forks and extends that baseline with:

| Area | Upstream (Claude CLI) | Jarvis Addition |
|---|---|---|
| Companion / personality | None | Full **Buddy System** — RPG-stats companion with species, rarity, hats, affection, pet events, animated terminal sprite |
| Background memory | Not present | **AutoDream** — forked subagent that consolidates session transcripts into long-term memory every 24 h / 5 sessions |
| Long-term memory | Basic MEMORY.md | **memdir** — structured memory directory with team memory, truncation guards, scan & search helpers |
| In-session memory | Not present | **Session Memory** — per-session markdown notes updated by a background subagent after each tool-loop turn |
| Living documentation | Not present | **Magic Docs** — markdown files tagged `# MAGIC DOC: title` are auto-updated by a forked agent as context evolves |
| Remote inference | Anthropic API only | **Remote GPT-OSS Bridge** — FastAPI WebSocket proxy (Python) routing turns to vLLM-hosted OSS models (120B / 20B), with Anthropic-compatible `/v1/messages` passthrough |
| Desktop shell | Not present | **Native Electron desktop** — dark chat-first GUI with animated WebGL background, companion dock, permission rail, model picker, Drive integration |
| Local inference | Not present | **8 GB VRAM path** — Ollama/Qwen fallback (`qwen2.5-coder:7b`) with llama.cpp support for heavier models; per-hardware guardrails |
| Automation | Not present | **Thunder Automation Panel** — GUI panel for controlling Thunder Compute sessions and terminal automation |
| Product name / brand | "Claude Code" | **Jarvis** — custom `appId`, product name, build artifacts, shortcut, and JARVIS_REPO_ROOT env wiring |

---

## Key Additions & Changes

### 1. Buddy Companion System

**`buddy/`**

Jarvis ships a full companion system — a persistent pixel-art character tied to the user's account UUID. On every session the companion is generated deterministically from the user's ID, so it can never be faked or broken by config edits.

- **18 species** (duck, dragon, octopus, capybara, robot, axolotl, ghost, …)
- **Rarity tiers** — common (60%), uncommon (25%), rare (10%), epic (4%), legendary (1%) — with rarity-scaled stat floors
- **RPG stats** — DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK — one peak, one dump, rest scattered
- **Cosmetics** — 6 eye types × 8 hats (wizard, halo, tinyduck, …), 1% shiny chance
- **Soul persistence** — name, personality, affection level, last-pet timestamp stored in config; bones re-derived on every read so edits can't fake a legendary
- **Animated terminal sprite** — 500 ms tick cycle, idle/fidget/blink frames, floating hearts on `/buddy pet`, speech bubble with fade window
- **Observer hook** — companion reacts to assistant turns, surfacing mood and commentary in the bubble
- **Desktop companion dock** — `CompanionDock.tsx` and `CompanionTab.tsx` render the companion in the Electron GUI with Framer Motion animations

**Files:** `buddy/companion.ts`, `buddy/sprites.ts`, `buddy/types.ts`, `buddy/CompanionSprite.tsx`, `buddy/useBuddyNotification.tsx`, `buddy/prompt.ts`

---

### 2. AutoDream — Background Memory Consolidation

**`services/autoDream/`**

AutoDream fires a forked subagent in the background to consolidate session transcripts into long-term memory notes, completely transparently to the user.

**How it works:**
1. **Time gate** — skipped if fewer than 24 hours (configurable via `tengu_onyx_plover` GrowthBook flag) have passed since the last consolidation
2. **Session gate** — skipped if fewer than 5 new sessions have accumulated
3. **Scan throttle** — minimum 10-minute interval between session-count scans even when the time gate passes
4. **Lock** — prevents two processes from consolidating simultaneously; rolls back on failure
5. The subagent runs with read-only bash constraints, writes updated memory files, and reports file paths back to the main session as an inline "Improved N memories" message

**GrowthBook knobs:** `tengu_onyx_plover.enabled`, `.minHours`, `.minSessions`

**Files:** `services/autoDream/autoDream.ts`, `services/autoDream/config.ts`, `services/autoDream/consolidationLock.ts`, `services/autoDream/consolidationPrompt.ts`

---

### 3. Memory Management (memdir)

**`memdir/`**

A structured directory-based long-term memory system with a canonical `MEMORY.md` entrypoint file.

- **MEMORY.md entrypoint** — 200-line / 25 KB cap with line-first then byte truncation; shared between the system prompt builder and `/claudemd`
- **Auto memory path** — configurable per-project memory root; `isAutoMemoryEnabled()` gate
- **Memory types** — frontmatter schema, `TRUSTING_RECALL_SECTION`, `WHAT_NOT_TO_SAVE_SECTION`, `WHEN_TO_ACCESS_SECTION`
- **Memory scan & search** — `memoryScan.ts`, `findRelevantMemories.ts`
- **Team memory** — `teamMemPaths.ts`, `teamMemPrompts.ts`, `utils/teamMemoryOps.ts` for shared team-level memory
- **Memory age tracking** — `memoryAge.ts` expiry logic

**Files:** `memdir/memdir.ts`, `memdir/paths.ts`, `memdir/memoryScan.ts`, `memdir/findRelevantMemories.ts`, `memdir/memoryAge.ts`, `memdir/memoryTypes.ts`

---

### 4. Session Memory

**`services/SessionMemory/`**

Automatic per-session markdown notes maintained by a background subagent, without interrupting the main conversation.

- Updates after each tool-loop turn once initialization and update thresholds are met
- `DEFAULT_SESSION_MEMORY_CONFIG` configures update cadence and token budgets
- Tracks whether extraction is in-flight to avoid pile-ups
- Integrates with the auto-compaction system — when the context is compacted, session memory is folded in

**Files:** `services/SessionMemory/sessionMemory.ts`, `services/SessionMemory/prompts.ts`, `services/SessionMemory/sessionMemoryUtils.ts`

---

### 5. Magic Docs

**`services/MagicDocs/`**

Any markdown file whose first line matches `# MAGIC DOC: <title>` is automatically kept up to date by a background subagent as the conversation evolves.

- Detected the moment the file is read by the `FileReadTool`
- After each assistant turn that contains tool calls, the forked updater agent merges new learnings into the file using `FileEditTool`
- Useful for living architecture notes, runbooks, or API references that stay synchronized with active coding sessions

**Files:** `services/MagicDocs/magicDocs.ts`, `services/MagicDocs/prompts.ts`

---

### 6. Remote GPT-OSS Bridge (Qwen × Claude)

**`server/remote_glm_bridge/`** + **`docs/remote-glm-bridge.md`**

The flagship remote inference path. Keeps all local tools, file state, and the permission rail on the desktop while offloading heavy reasoning to a GPU server running vLLM.

**Architecture:**
```
Local Desktop (tools + file state)
    │ HTTPS session create / WebSocket turn stream
    ▼
FastAPI Bridge (Thunder Compute / any H100)
    │ OpenAI-compatible /chat/completions
    ▼
GPT-OSS 120B / 20B  ←  primary / fast lane
    │ tagged reasoning + tool intents
    ▼
FastAPI Bridge  →  delta.thinking / delta.output_text / tool.call
    │
    ▼
Local StreamingToolExecutor  →  tool results + file snapshot  →  next turn
```

**Bridge features:**
- **Anthropic-compatible `/v1/messages` proxy** — the existing CLI keeps running without modification; just point `ANTHROPIC_BASE_URL` at the bridge
- **Three model lanes** — `gpt-oss-120b` (always strong), `gpt-oss-20b` (always fast), `gpt-oss-auto` (routes based on context size and turn complexity)
- **Custom bridge protocol** — `<thinking>`, `<final>`, `<tool_call>` XML tags parsed into normalized WebSocket events
- **Health probe endpoint** — `/healthz` checks upstream vLLM readiness; desktop launcher refuses to connect if the bridge is up but the model server is not
- **API key auth** — Bearer token or `X-Api-Key` header
- **Docker support** — `Dockerfile` + `.env.example` for containerized deployment
- **Session store** — `session_store.py` tracks active WebSocket sessions

**Files:** `server/remote_glm_bridge/main.py`, `glm_backend.py`, `protocol.py`, `schemas.py`, `config.py`, `session_store.py`

---

### 7. Native Electron Desktop Shell

**`desktop-electron/`**

A full Electron desktop application wrapping the Jarvis backend CLI process.

**Main process (`main.ts`):**
- Spawns `JarvisWorker.exe` (packaged) or the dev server as a child process
- Exposes a local HTTP + WebSocket backend and proxies events to all renderer windows via IPC
- Registers Thunder IPC handlers for terminal automation
- Uses `JARVIS_REPO_ROOT` env var for path resolution

**Renderer (`renderer/`):**
- `App.tsx` — chat-first dark UI with animated WebGL background (`WebGLBackground.tsx`), pinned composer (`InputArea.tsx`), transcript-first layout
- `TitleBar.tsx` — window chrome with model/backend controls
- `AgentStatusBar.tsx` — live agent status and cost display
- `CommandPalette.tsx` — searchable palette for all Jarvis commands
- `CompanionDock.tsx` / `CompanionTab.tsx` — companion rendered in the desktop GUI
- `DriveSetupWizard.tsx` — Google Drive integration setup
- `Slideover.tsx` — animated slide panel for settings / integrations
- `VerificationHold.tsx` — permission hold UI for tool approvals
- `ThunderAutomationPanel.tsx` — Thunder Compute automation control surface
- Framer Motion animations throughout (GENTLE / SNAPPY spring constants)

**Thunder integration (`thunder/`):**
- `thunderDetection.ts` — detects running Thunder sessions
- `thunderAutomation.ts` — scripted terminal automation
- `thunderTerminal.ts` — xterm.js embedded terminal
- `thunderIpc.ts` — IPC bridge between main and renderer

**Build:**
- `electron-builder.json` — `appId: com.jarvis.desktop`, product name `Jarvis`, outputs `Jarvis.exe`
- Packages `JarvisWorker.exe` as an extra resource alongside the renderer
- `scripts/build-jarvis-electron.mjs` — custom Electron build pipeline
- `scripts/build-desktop.ps1` — PowerShell build + optional desktop shortcut

**Files:** `desktop-electron/main.ts`, `preload.ts`, `preloadApi.ts`, `renderer/App.tsx`, `renderer/components/`, `thunder/`

---

### 8. Thunder Automation Panel

**`desktop-electron/renderer/components/ThunderAutomationPanel.tsx`**

A dedicated GUI panel within the Electron desktop for controlling Thunder Compute server sessions. Allows starting, stopping, and monitoring remote GPU jobs directly from the Jarvis desktop without leaving the chat interface. The `thunderAutomation.ts` layer handles scripted multi-step terminal sequences against the embedded xterm.js terminal.

---

### 9. Google Drive Brain (DriveSetupWizard)

**`desktop-electron/renderer/components/DriveSetupWizard.tsx`**

A step-by-step wizard inside the Electron desktop for connecting Google Drive as a persistent knowledge brain. Once connected, Drive acts as the backing store for long-term notes and documents that Jarvis can read and write during sessions — bridging the gap between ephemeral AI context and durable personal knowledge.

---

### 10. Jarvis Branding & Build Pipeline

Jarvis is rebranded throughout the build system:

- `electron-builder.json` — `appId: com.jarvis.desktop`, `productName: Jarvis`, artifact `Jarvis.exe`
- `desktop-electron/main.ts` — `JARVIS_REPO_ROOT` env var, `JarvisWorker.exe` packaged resource
- `package.json` — `desktop:build`, `desktop:dev`, `desktop:install` scripts wired to Jarvis-specific build scripts
- `docs/desktop-launcher.md` — full Jarvis launcher documentation
- `dist-jarvis/` — Jarvis Electron renderer build output

---

### 11. Expanded Tool Kit

Jarvis ships 45+ tools across all major categories. Notable additions and extensions over the upstream baseline:

| Tool | Description |
|---|---|
| `ScheduleCronTool` | Schedule AI agents to run on cron-like intervals (`CronCreateTool`, `CronDeleteTool`, `CronListTool`) |
| `WorkflowTool` | Define and execute multi-step named workflows with permission gates |
| `TungstenTool` | High-throughput structured output tool for bulk operations |
| `LSPTool` | Language Server Protocol integration for hover, definitions, diagnostics |
| `RemoteTriggerTool` | Trigger actions on remote Jarvis sessions |
| `SleepTool` | Explicit async sleep primitive for agent timing control |
| `SyntheticOutputTool` | Inject synthetic outputs into tool loops for testing and simulation |
| `BriefTool` | Summarize long context into a compact brief |
| `ToolSearchTool` | Semantic search over available tools |
| `TaskCreateTool` / `TaskGetTool` / `TaskListTool` / `TaskStopTool` / `TaskUpdateTool` / `TaskOutputTool` | Full task lifecycle management — create, monitor, and kill background agent tasks |
| `TeamCreateTool` / `TeamDeleteTool` | Spawn and destroy named multi-agent teams |

Over **101 slash commands** are registered under `commands/`, including:
`autofix-pr`, `bughunter`, `branch`, `advisor`, `ant-trace`, `ctx_viz`, `extra-usage`, `backfill-sessions`, `chrome`, `btw`, `effort`, `fast`, `heapdump`, and more.

---

### 12. Voice Mode

**`services/voice.ts`**, **`services/voiceStreamSTT.ts`**, **`services/voiceKeyterms.ts`**

Full voice input/output pipeline:
- **Native audio capture** via `audio-capture-napi` (cpal — CoreAudio on macOS, ALSA/PulseAudio on Linux, Windows via cpal)
- **Linux fallback chain** — native cpal → arecord (ALSA utils) → SoX `rec`
- **WSL detection** — distinguishes WSL1 (no audio), Win10-WSL2, and WSL2+WSLg (PulseAudio via RDP pipes)
- **Push-to-talk** and **auto-silence detection** modes (configurable threshold and duration)
- **STT streaming** — `voiceStreamSTT.ts` streams PCM audio to a speech-to-text endpoint
- **Key term extraction** — `voiceKeyterms.ts` identifies salient terms in audio transcripts for context injection
- **Lazy native module load** — `audio-capture-napi` loads on first voice keypress to avoid startup freeze

---

### 13. 8 GB VRAM Local Inference Path

Jarvis is specifically optimized for an 8 GB VRAM consumer GPU. The recommended local stack:

| Slot | Model | Notes |
|---|---|---|
| **Primary local** | `qwen2.5-coder:7b` via Ollama | Fits comfortably in 8 GB VRAM; strong code quality |
| **Heavy fallback** | `qwopus3.5-9b-v3:q4km` via llama.cpp | Q4 quantized, borderline 8 GB with `--gpu-layers` tuning |

**Per-hardware guardrails** baked into the desktop launcher:
- Local tool calling disabled by default until the model passes multi-turn validation
- Thinking mode disabled by default for local models (avoids runaway token budgets)
- Context length capped to prevent OOM on large prompts
- Session JSONL repair helper (`scripts/repair-session-jsonl.ts`) for broken parent chains from truncated local sessions

The remote GPT-OSS bridge (120B model on H100) is the primary path; local Qwen is the reliable fallback when internet is unavailable or the GPU server is down.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Electron Desktop (desktop-electron/)                  │
│  TitleBar · CompanionDock · InputArea · ThunderAutomationPanel · Drive    │
│  WebGL background · Framer Motion · CommandPalette · AgentStatusBar       │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ Electron IPC (preload.ts / preloadApi.ts)
┌────────────────────────────▼─────────────────────────────────────────────┐
│                     JarvisWorker CLI (main.tsx)                           │
│         Bootstrap → Query Loop → Tool Dispatcher → Cleanup               │
└──────┬──────────────────────┬──────────────────────────┬─────────────────┘
       │                      │                          │
┌──────▼──────┐   ┌───────────▼──────────┐   ┌──────────▼───────────────┐
│  Buddy      │   │   QueryEngine.ts      │   │  Background Services      │
│  System     │   │   (state, compaction) │   │  AutoDream · SessionMem   │
│  companion  │   └───────────┬───────────┘   │  MagicDocs · ExtractMem  │
│  sprites    │               │               └──────────────────────────┘
│  observer   │   ┌───────────▼──────────┐
└─────────────┘   │  Model Backend        │
                  │  ┌─ Anthropic API     │
                  │  ├─ Remote GPT-OSS    │◄─── server/remote_glm_bridge/
                  │  │    Bridge (FastAPI) │     (Python, vLLM, WebSocket)
                  │  └─ Local Ollama/Qwen │
                  └───────────┬───────────┘
                              │
                  ┌───────────▼──────────┐
                  │  Tool Dispatcher      │
                  │  45+ tools            │
                  │  Cron · Workflow       │
                  │  Tasks · Teams        │
                  └───────────────────────┘
```

---

## Directory Structure

```
Jarvis_-QwenXClaudeCLI-/
├── buddy/                    # Companion system (species, stats, sprites, soul)
├── services/
│   ├── autoDream/            # Background memory consolidation
│   ├── SessionMemory/        # Per-session auto-notes
│   ├── MagicDocs/            # Auto-updating living documentation
│   ├── extractMemories/      # Memory extraction subagent
│   ├── voice.ts              # Audio recording pipeline
│   ├── voiceStreamSTT.ts     # Streaming speech-to-text
│   └── voiceKeyterms.ts      # Voice key term extraction
├── memdir/                   # Structured long-term memory directory
├── server/
│   └── remote_glm_bridge/    # FastAPI GPT-OSS proxy (Python)
│       ├── main.py           # FastAPI app, WebSocket session management
│       ├── glm_backend.py    # OpenAI-compatible reasoning backend
│       ├── protocol.py       # Bridge protocol parser (<thinking>, <tool_call>)
│       ├── schemas.py        # Pydantic request/response models
│       ├── config.py         # Settings loader
│       └── session_store.py  # Active session registry
├── desktop-electron/         # Native Electron desktop application
│   ├── main.ts               # Main process (spawn worker, IPC, window)
│   ├── preload.ts / preloadApi.ts
│   ├── renderer/             # React GUI
│   │   ├── App.tsx           # Root chat shell
│   │   ├── components/       # CompanionDock, DriveSetupWizard, Thunder, …
│   │   └── store/            # Zustand agent store
│   └── thunder/              # Thunder Compute terminal automation
├── tools/                    # 45+ tool implementations
│   ├── ScheduleCronTool/     # Cron scheduling
│   ├── WorkflowTool/         # Multi-step workflows
│   ├── TungstenTool/         # Bulk structured output
│   ├── LSPTool/              # Language Server Protocol
│   ├── TaskCreateTool/ …     # Task lifecycle management
│   └── TeamCreateTool/ …     # Multi-agent teams
├── commands/                 # 101+ slash commands
├── dist-jarvis/              # Electron renderer build output
├── docs/
│   ├── desktop-launcher.md   # Jarvis desktop setup & usage guide
│   ├── remote-glm-bridge.md  # Remote GPT-OSS bridge documentation
│   └── tool-reference.generated.md
├── electron-builder.json     # Electron packager config (com.jarvis.desktop)
├── package.json              # Build scripts: desktop:build, desktop:dev, …
└── ClaudeCLIREADME.md        # Original upstream source README
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Language** | TypeScript 5.x (source), Python 3.11+ (bridge) |
| **Runtime** | Node.js 18+, Bun (dev/bundling) |
| **Terminal UI** | React 18 + Ink 6 |
| **Desktop GUI** | Electron 41, React 18, Framer Motion 11 |
| **3D / WebGL** | Three.js + @react-three/fiber + @react-three/drei |
| **AI SDK** | @anthropic-ai/sdk 0.82, Bedrock SDK, Vertex SDK |
| **Remote bridge** | FastAPI + uvicorn, WebSockets, OpenAI-compatible vLLM |
| **Local inference** | Ollama (qwen2.5-coder:7b), llama.cpp |
| **State management** | Zustand 4 |
| **MCP** | @modelcontextprotocol/sdk 1.29 |
| **Observability** | OpenTelemetry (traces, metrics, logs) |
| **Build** | esbuild 0.27, electron-builder 26 |
| **Audio** | audio-capture-napi (cpal), SoX, arecord |
| **Feature flags** | GrowthBook |

---

## Getting Started

### Desktop App (recommended)

```powershell
# Install dependencies
npm install

# Build the Jarvis Electron desktop
npm run desktop:build

# Or dev mode (hot reload)
npm run desktop:dev

# Build + create desktop shortcut
powershell -ExecutionPolicy Bypass -File scripts/build-desktop.ps1 -CreateShortcut
```

### Remote GPT-OSS Bridge

```bash
# Install Python dependencies
pip install -r server/remote_glm_bridge/requirements.txt

# Configure environment
export GPT_OSS_BRIDGE_API_KEYS="your-secret-key"
export GPT_OSS_BASE_URL="http://127.0.0.1:8000/v1"
export GPT_OSS_PRIMARY_MODEL="gpt-oss-120b"
export GPT_OSS_FAST_MODEL="gpt-oss-20b"

# Start the bridge
python -m server.remote_glm_bridge.main

# Or via Docker
docker build -f server/remote_glm_bridge/Dockerfile -t jarvis-gpt-oss-bridge .
docker run --rm -p 8787:8787 --env-file server/remote_glm_bridge/.env.example jarvis-gpt-oss-bridge
```

Then in the Jarvis desktop launcher:
1. Select backend → **Remote**
2. Bridge URL → `http://your-server:8787`
3. Bridge API key → value from `GPT_OSS_BRIDGE_API_KEYS`
4. Lane → **Auto** (routes between 120B and 20B automatically)

### CLI (headless)

```bash
npm install
npm run start
```

### Local Qwen Fallback

```bash
# Pull the recommended local model
ollama pull qwen2.5-coder:7b

# In Jarvis desktop: Backend → Local, Model → qwen2.5-coder:7b
# Keep tools disabled until multi-turn validation passes
```

---

## Original Source Reference

This repository is built on top of the **Claude Code CLI** source (decompiled/reconstructed, `@anthropic-ai/claude-code-source` v2.1.88). The original upstream README is preserved at [`ClaudeCLIREADME.md`](./ClaudeCLIREADME.md).

All upstream capabilities are preserved and fully functional — Jarvis adds on top of, not in place of, the original foundation.

---

<div align="center">

Built with 🦆 by Ethan Jansen — Jarvis is your personal AI, your way.

</div>
