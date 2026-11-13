# Unify — Plan for real AI connections and context handoffs

Status: draft for discussion (Nov 13, 2026). Nothing here is built yet. `prototype/index.html` is a UI mock only.

## 1. Main recommendation: drive the official CLIs locally and keep API keys as an opt-in fallback

The only reliable, terms-compliant way to use **subscription allowances** (Claude Pro/Max, ChatGPT Plus/Pro) from a third-party app today is to
**run each vendor's own official agent CLI on the user's machine, signed in by the user**, and have Unify orchestrate it:

| Provider | How Unify connects | Billing | Notes / verify |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` (user runs `claude login` themselves) | User's Claude subscription or their own API key, handled by Claude Code | Unify never sees or stores Claude OAuth tokens. Third-party apps may **not** offer "log in with Claude.ai" or reuse subscription credentials through the Agent SDK. Re-verify Anthropic's current terms before shipping. |
| Codex | `codex exec --json` (user signs in with ChatGPT in the Codex CLI) | ChatGPT plan allowance or API key | Also check OpenAI's "use your ChatGPT plan in other apps" program as a later, native option. |
| Gemini | `gemini` CLI (Google login) or Gemini API key | Free tier/quota or paid API | Quotas change often. |
| DeepSeek, NVIDIA NIM, OpenRouter, etc. | OpenAI-compatible HTTP API with a key stored in the macOS Keychain | Pay per use / trial credits | **Never a silent fallback.** These need a budget cap and explicit opt-in. |
| Local (Ollama, LM Studio) | localhost HTTP | Free (your hardware) | A good "always available" last resort. |

This keeps Unify honest: it never holds subscription credentials, and every provider is used through a path its vendor supports.
Because it needs local processes, a **desktop app is the real product**. A cloud preview can only demo API-key providers.

**Stack:** TypeScript throughout. A local **engine** (Node, SQLite) is a separate module from the **UI** (React). For the Mac app, I recommend
**Electron**. Its Node main process can spawn the CLIs and reuse the vendor SDKs directly, which matters more here than Tauri's smaller app size.
You can switch the shell later because the engine stays separate from it.

## 2. Context engine: the project owns its state, not the model

The key rule is that **the next model's handoff packet is already written before the current model runs out**. It is built continuously from
data Unify records itself, never by asking the exhausted model to summarize.

Stored per project (SQLite + the project's git repo):

1. **Event log (append-only).** Every user message, model output, tool call, file edit, and error, tagged with the provider and model that produced it.
2. **Git as ground truth for code.** Each agent works in its own git worktree or branch. Unify auto-commits a checkpoint after each turn, so a
   handoff points at a concrete commit and diff, not a description of one.
3. **Structured project state**, updated after every turn:
   - Goal, constraints, and decisions (with who decided and when)
   - Task list (status and owner)
   - Files touched, plus the last diff
   - Open questions, plus the last error or blocker
   - "In-flight": what the agent was doing when it stopped
4. **How state stays current without the exhausted model:**
   - Deterministic extraction (no AI needed): diffs, files touched, commands run, test results, and errors come straight from the CLI's JSON stream and git.
   - Agent-maintained notes: every provider gets the same system instruction to keep `.unify/state.md` (tasks, decisions, next step) updated as it goes. This is cheap and done during work, not afterward.
   - Optional rolling distillation: after each turn, a cheap or local model compresses new events into the state. It runs in the background and is never on the critical path.
5. **Handoff packet** = a template-rendered prompt for the next provider: goal, constraints/decisions, current task and in-flight step,
   the checkpoint commit and diff summary, relevant files (picked by recency and references, trimmed to the target model's context window),
   and a "what's stale or missing" section. Provenance is preserved. The packet is shown to the user and can be edited.

## 3. Router and handoff

- The user sets a priority order per project (e.g., Claude Code → Codex → Gemini → Local → DeepSeek API).
- Each adapter reports `available | rate_limited(until) | quota_exhausted | auth_needed | error` by parsing CLI exit codes and stream errors,
  plus HTTP 429/402 for APIs.
- When the active provider hits a limit, Unify will:
  1. Mark its turn **interrupted** and snapshot the worktree. Partial edits stay as uncommitted changes, flagged in the packet.
  2. Choose the next eligible provider: it must be connected and capable, and if it's paid, it must be under budget.
  3. **Paid providers ask first**, unless the user pre-approved a spend cap for this project.
  4. Start the next provider with the handoff packet and the same worktree.
  5. Show a visible "handoff" card in the chat. Return to the preferred provider when its limit resets (optional).
- Safety: Unify does not automatically re-run interrupted shell commands or side-effecting tool calls. It lists them for the new agent or the user to confirm.

## 4. Running many AIs at once (later)

Start with **one active agent per project plus fallbacks**. For parallel work, use a coordinator pattern: tasks have a single owner, each agent
gets its own worktree, results are merged by PR-like review, and consequential actions need human approval. A "compare answers" mode
(same prompt to N models, side by side) is easy and useful early. 16 simultaneous coding agents is not a good early goal.

## 5. MVP milestones

1. **M0, foundations (about 1 week).** Monorepo (`engine/`, `app/`), SQLite schema (projects, events, checkpoints, tasks, providers), a provider-adapter interface, and a fake adapter for tests.
2. **M1, two real providers.** Claude Code CLI and Codex CLI adapters: streaming output into the chat UI, plus detection of installed/signed-in/limit status. Real chat in a project folder.
3. **M2, context engine v1.** Event log, per-turn checkpoint commits, `.unify/state.md` convention, and handoff packet rendering with a preview UI.
4. **M3, one controlled handoff.** A manual "Hand off to Codex" button first, then automatic on detected limit. Tests: simulated rate limit mid-task, then verify the next agent gets goal, decisions, diff, and in-flight step, with no duplicated side effects.
5. **M4, My AIs + safety.** DeepSeek/NVIDIA/OpenRouter via Keychain-stored keys, budget caps, a "never auto-use paid" default, and a usage view.
6. **M5, Mac app.** Electron packaging, liquid-glass styling from the prototype, signing/notarization.
7. **Later.** Image generation adapters, a parallel agents/compare mode, cloud sync, and native OpenAI "use your plan" if eligible.

After the MVP (decided Nov 13, 2026; see section 7):

8. **M6, multiple accounts per AI.** "Claude Code (Personal)" and "Claude Code (Work)" as separate providers, each with its own CLI config folder (`CLAUDE_CONFIG_DIR`; `CODEX_HOME` for Codex), signed in from the app, plus a default account per project. Verify both variables against the installed CLI versions first.
9. **M7, easy install.** A downloadable .dmg with first-run setup: detect or install `claude`/`codex` with their official installers, open each sign-in, and run the doctor checks with green ticks. Unsigned for now, so the first launch is right-click → Open and updates are an in-app "new version available" link (macOS auto-update needs signing). Add signing and notarization when there's an Apple Developer account; nothing else changes.
10. **M8, phone as a remote.** A home-screen web app first (native later) that connects to your home base (section 7) through QR pairing over a secure link or Tailscale. The local server currently accepts only connections from the same machine, so this needs pairing and per-device sign-in. With every Mac off, the phone can still chat through API providers but not the coding agents.
11. **M9, accounts and sync.** Unify accounts, end-to-end encrypted sync of the event log, projects, settings and priorities, and snapshot refs pushed to the project's git remote so another runner can continue. CLI sign-ins never sync; API keys sync only end-to-end encrypted.

## 6. Decisions

Decided (Nov 13, 2026): the name is **Unify.js** (a trademark check is still needed before public launch). First providers: **Claude Code, then Codex**.
Built so far: M0 engine; M1 chat app with Claude Code and Codex adapters (verified on macOS: both connect and resume, and a real Claude Code → Codex handoff passed); M2 git snapshot after every turn; M4 NVIDIA catalog with model picker (free trial, rate-limited) and DeepSeek with approval, spending caps, and encrypted keys (tested against a local mock API, not the real one); M5 Electron shell (runs on macOS; `npm install` works on Node 26; not yet packaged as a .dmg or signed). NVIDIA verified live on macOS with Mistral Large 4 (`mistralai/mistral-large-4-1t-a52b`; the old Llama 3.3 default was retired).

Decided (Nov 13, 2026): no Apple Developer account yet (ship unsigned); the phone only needs to work while a runner is on (an always-on home base); sync starts single-user but is designed for friends and family with their own accounts and integrations (section 7). M6 built (Nov 13, 2026): extra Claude Code / Codex accounts with separate config folders, sign-in from the app via Terminal, account shown as email + plan, rename/remove, and per-project on/off. Checked on macOS that an empty `CLAUDE_CONFIG_DIR` / `CODEX_HOME` reports "not signed in" while the default accounts stay signed in; verified in the desktop app that a second entry signs in through Terminal, shows as signed in, and removes cleanly while the main sign-in stays intact. M7 in progress (Nov 13, 2026): `npm run dist:mac` builds Apple Silicon and Intel .dmg files, ad-hoc signed by an afterPack hook (electron-builder can't ad-hoc sign by itself, and an unsigned bundle shows as "damaged" on Apple Silicon); the packaged app was checked to start and find the CLIs. First-run **Get started** screen: install (Terminal, official installers), sign in, test reply, pick a folder. Downloads are GitHub Releases on this public repo (decided Nov 13, 2026; no license yet, so the code is visible but not licensed for reuse). Builds are signed with a self-signed "Unify.js Self-Signed" certificate kept in the release Mac's Keychain (backup in ~/Documents/Unify.js signing/), so updates keep the same identity and the Keychain doesn't re-prompt for stored API keys; other machines fall back to ad-hoc. `npm run release` (in `desktop/`) builds and publishes; the app shows "Update available" from the latest release, checked in the background every 6 hours.

Still open:

- Confirm "drive official CLIs locally" as the core subscription strategy.
- Electron vs. Tauri: recommend Electron.
- Development setup: M1 needs a Mac (or any machine) with the CLIs installed. This cloud session can build the engine and UI and test them with fake adapters, but it can't sign into Ranen's accounts.

## 7. Devices, accounts, and other people

- **Home base.** Ranen has an always-on computer that runs Unify, holds the projects, and is signed in to the CLIs. Phones and laptops are clients; any signed-in machine that is online can be a runner, and the default runner for a project is the home base. The phone only needs to work while some runner is on.
- **No cloud runners for subscriptions.** Running people's Claude/ChatGPT subscription CLIs on a hosted server is likely against the providers' terms and costs money, so it is out of scope.
- **Built for friends and family from the start**, though it starts with one user:
  - Everyone brings their own AI accounts, keys and computers. A runner never runs someone else's work on its owner's subscriptions (privacy, and providers forbid account sharing).
  - Each person has their own Unify account; projects and history are encrypted on their devices, so the sync server (and whoever operates it) cannot read them.
  - Integrations (which AIs, priority order, keys) are per person.
  - Later: inviting someone to a single project. Leave room for it in the data model, but don't build it first.
