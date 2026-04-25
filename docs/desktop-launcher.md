# Jarvis Desktop

Jarvis is the desktop launcher for this repo's Claude Code-derived runtime. It hosts the local control surface in the browser, keeps the local tool and file loop on your machine, and can route long-horizon reasoning through a remote GPT-OSS bridge.

## Built artifacts

- Desktop launcher executable: `dist-desktop/ClaudeCodeDesktop.exe`
- Optional desktop shortcut: `Claude Body Desktop.lnk`

The visible product is now **Jarvis**, but the existing executable and storage names stay compatible with the older launcher setup in this pass.

Build them with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-desktop.ps1 -CreateShortcut
```

## How to launch

1. Double-click `Claude Body Desktop.lnk` on the desktop, or run `dist-desktop/ClaudeCodeDesktop.exe`.
2. Jarvis starts a local web app and opens the desktop shell in the browser.
3. Pick the backend you want:
   - `Remote` for the GPT-OSS bridge and rented server workflow.
   - `Local` for the Ollama fallback path.
   - `Anthropic` for the native Claude-compatible path.

## Recommended default flow

Use Jarvis in this order:

- Backend: `Remote`
- Bridge URL: your GPT-OSS bridge, for example `http://YOUR_SERVER:8787`
- Lane: `Auto` or `120B`

This is the flagship path. Jarvis is now designed remote-first, with the transcript, permissions, and prompt rail centered around the GPT-OSS server connection.

## Local fallback

Keep these local models available as backup:

- Preferred fallback: `qwen2.5-coder:7b`
- Legacy alternate: `qwopus3.5-9b-v3:q4km`

For most local fallback use on this hardware:

- Backend: `Local`
- Model: `qwen2.5-coder:7b`
- Disable tools in local mode: `on`
- Disable thinking in local mode: `on`

Jarvis still supports the dedicated `llama.cpp` path for the heavier Qwopus model, but that path is now secondary and is no longer the primary launcher experience.

## Current desktop features

Jarvis now includes:

- A dark, chat-first shell with a pinned composer and transcript-first layout.
- Remote GPT-OSS bridge controls with health checks and lane selection.
- A compact permission rail for tool approvals.
- AutoDream, Memory, Integrations, and Companion workspaces.
- Saved integration registry entries persisted in launcher state.
- Installed-model selection and a cleaner local fallback presentation.
- Persisted desktop transcript and compact local conversation memory for safe-mode restarts.
- A repeated-tool-call guard for future experimental local-tool sessions.
- A session repair helper at `scripts/repair-session-jsonl.ts` for broken JSONL parent chains and orphaned `tool_result` blocks.

## Local tool validation

When you are ready to validate local tool calling, the best next target on this hardware is still `qwen2.5-coder:7b`.

Before enabling local tools, verify:

1. The model consistently emits valid JSON tool arguments.
2. Multi-turn tool loops complete without duplicate or empty tool calls.
3. Large prompts are summarized or trimmed before the model runs out of context.
4. Permission prompts in Jarvis still round-trip correctly.

Until those checks pass, keep local tools disabled and treat the local path as fallback.

## Native Anthropic path

Anthropic mode is still preserved for full feature parity. The local compatibility shims only activate when Jarvis is configured for a non-Anthropic backend.
