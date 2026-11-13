# Unify.js

One workspace for many AIs. Its context engine keeps a ready-made handoff, so when one provider hits a limit, the next one continues the work.

**Status:** early engine (milestone M0). There is no UI or desktop app yet. `prototype/index.html` is the visual concept.

- `engine/src/db.js`: durable project state (Node's built-in SQLite): event log, checkpoints, priorities
- `engine/src/context.js`: folds every event into structured state and renders the handoff packet. It never calls a model.
- `engine/src/router.js`: priority order, limit detection and cooldown, approval required for paid providers, flags interrupted commands
- `engine/src/adapters/`: Claude Code CLI, Codex CLI, and a scripted fake used for tests and the demo

```sh
npm test       # Node >= 22.13, no dependencies
npm run demo   # simulated Claude Code -> Codex handoff
```

See `docs/PLAN.md` for the roadmap and `docs/HANDOFF.md` for the original brief.
