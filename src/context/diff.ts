/** Decode Git's quoted byte sequences as UTF-8, not individual code points. */
export function decodeGitPath(raw: string): string {
  raw = raw.replace(/\t?\r?$/, '');
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const text = raw.slice(1, -1);
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') {
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1));
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length + 1; continue; }
      const escaped = text[++i]!;
      const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07' };
      bytes.push(...Buffer.from(escapes[escaped] ?? escaped)); i++;
    } else {
      const char = String.fromCodePoint(text.codePointAt(i)!);
      bytes.push(...Buffer.from(char)); i += char.length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function diffSectionPath(section: string): string | undefined {
  const header = /^diff --git (.+)\r?$/m.exec(section)?.[1];
  if (header) {
    const quoted = / ("b\/(?:\\.|[^"\\])*")\t?\r?$/.exec(header);
    if (quoted) return decodeGitPath(quoted[1]!).slice(2);
    // With --no-renames both paths are identical, including embedded spaces.
    for (let at = header.indexOf(' b/'); at >= 0; at = header.indexOf(' b/', at + 1)) {
      const left = decodeGitPath(header.slice(0, at)).slice(2);
      const right = decodeGitPath(header.slice(at + 1)).slice(2);
      if (left === right) return right;
    }
  }
  const line = /^(?:\+\+\+|---) (.+)$/m.exec(section)?.[1];
  const decoded = line ? decodeGitPath(line) : undefined;
  return decoded && /^[ab]\//.test(decoded) ? decoded.slice(2) : undefined;
}

export function cleanDiff(diff: string): { diff: string; truncated: boolean } {
  const at = diff.search(/^\[Quorum: (?:diff truncated at 512 KiB|command output truncated)\]\r?$/m);
  return { diff: at < 0 ? diff : diff.slice(0, at), truncated: at >= 0 };
}
