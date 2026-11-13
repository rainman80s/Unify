# Unify.js

One workspace for many AIs. Its context engine keeps a ready-made handoff, so when one provider hits a limit, the next one continues the work.

**Status:** engine, chat app, git snapshots, and an Electron desktop shell (M0–M2 plus early M5). Verified on macOS on Nov 13, 2026: Claude Code 2.1.323 and Codex 0.169.0 connect, resume their conversations, and complete a real Claude Code → Codex handoff (`npm run doctor -- --handoff`). The desktop app hasn't been built or signed on a Mac yet. `prototype/index.html` is the original visual concept.

- `engine/src/db.js`: durable project state (Node's built-in SQLite): event log, checkpoints, priorities
- `engine/src/context.js`: folds every event into structured state and renders the handoff packet. It never calls a model.
- `engine/src/router.js`: priority order, limit detection and cooldown, approval required for paid providers, flags interrupted commands
- `app/server.js` + `app/index.html`: local chat UI: streaming replies, handoff cards, "see what was sent", priority order, pause/hand off now, goal and decisions
- `engine/src/git.js`: after every turn, saves a snapshot of the working tree to `refs/unify/<project>` (a temporary index, so your branch, staging, and files are untouched). The handoff packet cites the commit and diffstat.
- `engine/src/adapters/openai-compatible.js`: DeepSeek (and any OpenAI-compatible API, such as NVIDIA NIM or OpenRouter). Paid AIs never run without your approval in the app. You set a per-project spending cap, which also limits how long each reply can be. Keys live in `app/secrets.js`: encrypted with the OS keychain in the desktop app, or read from `DEEPSEEK_API_KEY` otherwise, and never written to chat history or packets.
- NVIDIA API catalog (`nvidiaAdapter`): free trial tier, rate-limited and for prototyping. No approval prompt and no cost, and a 429 only pauses it for about a minute. My AIs lists the live model catalog for your key, and you choose the model.
- `desktop/`: Electron shell. It runs the server in-process, adds File → Open Project Folder… (switches to real mode for that folder), borrows your login-shell PATH so a Finder-launched app can find `claude`/`codex`, and uses macOS vibrancy and inset traffic lights.
- `engine/src/adapters/`: Claude Code CLI, Codex CLI, and a scripted fake used for tests and the demo
- Multiple accounts per AI: in My AIs, **Add another account** (e.g. a work Claude Code next to your personal one). Each extra account gets its own CLI config folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), so its sign-in stays separate; **Sign in** opens Terminal with the real `claude auth login` / `codex login`. Any AI can be switched off per project, so a work repo only uses your work account.

```sh
npm start          # chat app at http://127.0.0.1:4317 with simulated Claude Code + Codex
UNIFY_CWD=~/code/my-project npm run start:real   # uses YOUR installed, signed-in claude + codex CLIs in that folder
npm test       # Node >= 22.13, no dependencies
npm run demo   # simulated Claude Code -> Codex handoff
```

**On a Mac:** follow `docs/MAC_SETUP.md`. `npm run doctor -- --handoff` tests every real connection.

See `docs/PLAN.md` for the roadmap and `docs/HANDOFF.md` for the original brief.

## Desktop app
```sh
cd desktop && npm install   # also rebuilds better-sqlite3 for Electron (Electron has no node:sqlite)
npm start                   # opens in demo mode; File > Open Project Folder… for real mode
npm run dist:mac            # builds .dmg files for Apple Silicon and Intel (signed with the self-signed release certificate if present, else ad-hoc; see desktop/mac-sign.cjs)
```
**Releasing:** bump `version` in `desktop/package.json`, commit to `main`, then `cd desktop && npm run release`. It builds both .dmg files and publishes a GitHub Release; installed apps show "Update available" (they can't update themselves until the app is signed).

On first launch the app shows **Get started**: it checks for Claude Code and Codex, installs them with their official installers and opens each sign-in (both in Terminal, so you see what runs), sends a tiny test message, and asks for a project folder. See `docs/MAC_SETUP.md` for the first-open steps on macOS.

## Real mode, first run on your Mac
1. Install and sign in to Claude Code (`claude`) and Codex (`codex`) yourself. Unify.js never sees those logins.
2. `UNIFY_CWD=/path/to/a/test/repo npm run start:real`. Use a throwaway repo first: both agents can edit files there.
3. Run `npm run doctor -- --handoff` after updating either CLI. Their output formats can change, and the doctor saves the raw output so the parsers can be fixed.
