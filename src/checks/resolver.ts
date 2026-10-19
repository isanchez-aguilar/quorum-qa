import { statSync } from 'node:fs';
import path from 'node:path';

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  exists?: (file: string) => boolean;
}

export function resolveCommand(command: string, args: string[], options: ResolveOptions = {}) {
  const windows = (options.platform ?? process.platform) === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const value = (name: string) => Object.entries(env).find(([key]) =>
    windows ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1];
  const exists = options.exists ?? ((file: string) => {
    try { return statSync(file).isFile(); } catch { return false; }
  });
  const cwd = paths.resolve(options.cwd ?? process.cwd());
  if (!command || command.includes('\0')) throw new Error('Invalid command');
  const extensions = windows && !paths.extname(command)
    ? (value('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.[a-z0-9]+$/i.test(ext))
    : [''];
  const directories = (value('PATH') ?? '').split(windows ? ';' : ':')
    .map(dir => dir.replace(/^"(.*)"$/, '$1'))
    .filter(dir => paths.isAbsolute(dir) && (windows
      ? paths.resolve(dir).toLowerCase() !== cwd.toLowerCase()
      : paths.resolve(dir) !== cwd));
  const candidates = paths.isAbsolute(command) ? [command]
    : /[/\\]/.test(command) ? [] : directories.map(dir => paths.join(dir, command));
  const file = candidates.flatMap(candidate => extensions.map(ext => candidate + ext)).find(exists);
  if (!file) throw new Error(`Command not found on PATH: ${command}`);
  if (windows && /\.(cmd|bat)$/i.test(file)) {
    for (const part of [file, ...args]) {
      const character = part.match(/[&|<>^%!;"\r\n\0]/)?.[0];
      if (character) throw new Error(`Disallowed command metacharacter: ${character === '\r' ? 'CR' : character === '\n' ? 'LF' : character === '\0' ? 'NUL' : character}`);
    }
    const comspec = value('ComSpec');
    const systemRoot = value('SystemRoot');
    return {
      file: comspec && paths.isAbsolute(comspec) && exists(comspec) ? comspec
        : paths.join(systemRoot && paths.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c', `"${[file, ...args].map(part => `"${part}"`).join(' ')}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file, args };
}
