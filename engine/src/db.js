// Durable project state, using Node's built-in SQLite (no dependencies).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, goal TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
-- Append-only log of everything that happened, with provenance.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, turn_id TEXT,
  provider TEXT, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);
-- Structured state, rewritten after every event so a handoff never waits on a model.
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, upto_seq INTEGER NOT NULL,
  state TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS priorities (
  project_id TEXT NOT NULL, provider TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider)
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const now = () => new Date().toISOString();

  return {
    raw: db,
    createProject({ id, name, cwd = null, goal = '' }) {
      db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(id, name, cwd, goal, now());
      return this.getProject(id);
    },
    getProject(id) {
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    },
    appendEvent(projectId, { turnId = null, provider = null, type, data = {} }) {
      const r = db.prepare('INSERT INTO events (project_id, turn_id, provider, type, data, at) VALUES (?,?,?,?,?,?)')
        .run(projectId, turnId, provider, type, JSON.stringify(data), now());
      return Number(r.lastInsertRowid);
    },
    events(projectId, afterSeq = 0) {
      return db.prepare('SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq')
        .all(projectId, afterSeq).map(e => ({ ...e, data: JSON.parse(e.data) }));
    },
    saveCheckpoint(projectId, uptoSeq, state) {
      db.prepare('INSERT INTO checkpoints (project_id, upto_seq, state, at) VALUES (?,?,?,?)')
        .run(projectId, uptoSeq, JSON.stringify(state), now());
    },
    latestCheckpoint(projectId) {
      const row = db.prepare('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId);
      return row ? { ...row, state: JSON.parse(row.state) } : null;
    },
    setPriorities(projectId, providerIds) {
      db.prepare('DELETE FROM priorities WHERE project_id = ?').run(projectId);
      const ins = db.prepare('INSERT INTO priorities VALUES (?,?,?)');
      providerIds.forEach((p, i) => ins.run(projectId, p, i));
    },
    priorities(projectId) {
      return db.prepare('SELECT provider FROM priorities WHERE project_id = ? ORDER BY rank').all(projectId).map(r => r.provider);
    },
    close() { db.close(); },
  };
}
