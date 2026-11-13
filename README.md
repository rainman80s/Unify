# Unify.js

One workspace for many AIs. Its context engine keeps a ready-made handoff, so when one provider hits a limit, the next one continues the work.

**Status:** engine and local chat app with a working handoff (milestones M0–M1). This is not yet a packaged Mac app. `prototype/index.html` is the original visual concept.

- `engine/src/db.js`: durable project state (Node's built-in SQLite): event log, checkpoints, priorities
- `engine/src/context.js`: folds every event into structured state and renders the handoff packet. It never calls a model.
- `engine/src/router.js`: priority order, limit detection and cooldown, approval required for paid providers, flags interrupted commands
- `app/server.js` + `app/index.html`: local chat UI: streaming replies, handoff cards, "see what was sent", priority order, pause/hand off now, goal and decisions
- `engine/src/git.js`: after every turn, saves a snapshot of the working tree to `refs/unify/<project>` (a temporary index, so your branch, staging, and files are untouched). The handoff packet cites the commit and diffstat.
- `engine/src/adapters/`: Claude Code CLI, Codex CLI, and a scripted fake used for tests and the demo

```sh
npm start          # chat app at http://127.0.0.1:4317 with simulated Claude Code + Codex
UNIFY_CWD=~/code/my-project npm run start:real   # uses YOUR installed, signed-in claude + codex CLIs in that folder
npm test       # Node >= 22.13, no dependencies
npm run demo   # simulated Claude Code -> Codex handoff
```

See `docs/PLAN.md` for the roadmap and `docs/HANDOFF.md` for the original brief.

## Real mode, first run on your Mac
1. Install and sign in to Claude Code (`claude`) and Codex (`codex`) yourself. Unify.js never sees those logins.
2. `UNIFY_CWD=/path/to/a/test/repo npm run start:real`. Use a throwaway repo first: both agents can edit files there.
3. Real-mode parsing of each CLI's JSON output is based on their documented formats and has not yet been run against live CLIs. Expect small fixes.
