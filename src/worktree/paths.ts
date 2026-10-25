import path from 'node:path';

export function checksWorktreePath(repo: string, home: string, id: string, platform: string) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normal = paths.join(repo, '.quorum', 'worktrees', id);
  const short = platform === 'win32' && normal.length + 150 > 260;
  const location = short ? paths.join(home, '.quorum', 'wt', id.replace(/-/g, '').slice(0, 8)) : normal;
  return { location, parent: paths.dirname(location), short,
    warning: platform === 'win32' && location.length + 150 > 260
      ? `Checks worktree path length ${location.length} + 150 exceeds 260 characters even with the selected root.` : undefined };
}

export function pathLengthCheck(repo: string, platform: string, longpaths: string | undefined) {
  const length = checksWorktreePath(repo, '', '0'.repeat(36), platform);
  const risky = platform === 'win32' && length.short && longpaths?.trim().toLowerCase() !== 'true';
  return { id: 'paths.length', status: risky ? 'WARN' as const : 'PASS' as const,
    message: risky ? `Repository path length ${repo.length} risks Windows long paths; core.longpaths is not true.` : 'Repository path length or Git long-path support is acceptable.',
    ...(risky ? { fix: 'Run git config core.longpaths true; move the repository to a shorter path if tools still fail.' } : {}) };
}
