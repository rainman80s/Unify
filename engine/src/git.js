// Git checkpoints: after every turn, snapshot the working tree to refs/unify/<project>
// WITHOUT touching the user's branch, index, or files (uses a temporary index).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const git = async (cwd, args, env = {}) =>
  (await run('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 20e6 })).stdout.trim();

export async function isGitRepo(cwd) {
  try { return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'; } catch { return false; }
}

export function gitCheckpointer({ cwd, projectId }) {
  const ref = `refs/unify/${projectId}`;
  return {
    async checkpoint({ provider, label }) {
      if (!(await isGitRepo(cwd))) return null;
      const dir = await mkdtemp(join(tmpdir(), 'unify-idx-'));
      try {
        const env = { GIT_INDEX_FILE: join(dir, 'index') };
        const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
        const prev = await git(cwd, ['rev-parse', '--verify', '-q', ref]).catch(() => '');
        if (head) await git(cwd, ['read-tree', 'HEAD'], env);
        await git(cwd, ['add', '-A', '.'], env); // respects .gitignore
        const tree = await git(cwd, ['write-tree'], env);
        if (prev && (await git(cwd, ['rev-parse', `${prev}^{tree}`])) === tree) return { commit: prev, unchanged: true, base: head || null };
        const parents = [prev || head].filter(Boolean).flatMap(p => ['-p', p]);
        const ident = { GIT_AUTHOR_NAME: 'Unify.js', GIT_AUTHOR_EMAIL: 'unify@localhost', GIT_COMMITTER_NAME: 'Unify.js', GIT_COMMITTER_EMAIL: 'unify@localhost' };
        const commit = await git(cwd, ['commit-tree', tree, ...parents, '-m', `Unify.js checkpoint: ${label} (${provider})`], ident);
        await git(cwd, ['update-ref', ref, commit]);
        const diffstat = head ? await git(cwd, ['diff', '--stat', head, commit]) : '';
        return { commit, base: head || null, diffstat };
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
  };
}
