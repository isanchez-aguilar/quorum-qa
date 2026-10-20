export interface ApiExport { name: string; signature: string; line: number; renameSignature: string; comparisonSignature?: string }
export interface ApiChange {
  file: string; name: string; kind: 'added' | 'removed' | 'changed' | 'renamed';
  before?: string; after?: string; previousName?: string; line: number; breaking: boolean;
  overloads?: { before: number; after: number };
}
export interface PackageChange { field: string; before: unknown; after: unknown }
export interface ApiEvidence { changes: ApiChange[]; packageChanges: PackageChange[]; breaking: boolean; notes: string[]; incomplete?: boolean; unscanned?: string[] }
export const API_INPUT_BYTES = 256 * 1024;
export const unsupportedSource = (file: string) => /\.(?:py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|m|scala|dart)$/i.test(file);
interface Token { value: string; start: number; end: number; line: number; quoted?: boolean }
const identifier = (char: string) => /[A-Za-z0-9_$]/.test(char);

/** A bounded, forward-only lexer. Quoted text and comments never introduce exports. */
function tokens(source: string): Token[] {
  const result: Token[] = [];
  let line = 1;
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (char === '\n') { line++; i++; continue; }
    if (/\s/.test(char)) { i++; continue; }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; }
      i = Math.min(i + 2, source.length); continue;
    }
    if (char === '/' && ['=', '(', '[', ':', ',', 'return', 'throw', 'yield', 'await', 'void', 'typeof', 'delete', 'case', '!', '?', '>', '&', '|', '+', '-', '*', '%', '~', '^'].includes(result.at(-1)?.value ?? '=')) {
      i++; let bracket = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') bracket = true;
        if (source[i] === ']') bracket = false;
        if (source[i] === '/' && !bracket) { i++; while (i < source.length && /[a-z]/i.test(source[i]!)) i++; break; }
        i++;
      }
      continue;
    }
    const start = i; const startLine = line;
    if (char === '"' || char === "'" || char === '`') {
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\n') line++;
        if (source[i] === '\\') i++;
        i++;
      }
      result.push({ value: source.slice(start + 1, i), start, end: Math.min(++i, source.length), line: startLine, quoted: true });
    } else if (identifier(char)) {
      while (i < source.length && identifier(source[i]!)) i++;
      result.push({ value: source.slice(start, i), start, end: i, line });
    } else { i++; result.push({ value: char, start, end: i, line }); }
  }
  return result;
}
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const isName = (token?: Token) => !!token && !token.quoted && /^[A-Za-z_$][\w$]*$/.test(token.value);
interface ScanResult { exports: ApiExport[]; notes: string[]; incomplete: boolean }

/** Public convenience API; comparison also consumes the scanner's coverage diagnostics. */
export function scanExports(input: string): ApiExport[] { return scanFile(input, '<input>').exports; }

function scanFile(input: string, file: string): ScanResult {
  const notes = new Set<string>();
  const note = (reason: string) => notes.add(`${file}: ${reason}`);
  const bytes = Buffer.from(input);
  if (bytes.length > API_INPUT_BYTES) note('API input cap: 256 KiB per file.');
  const source = bytes.subarray(0, API_INPUT_BYTES).toString('utf8');
  const lex = tokens(source); const result: ApiExport[] = [];
  const value = (i: number) => lex[i]?.quoted ? undefined : lex[i]?.value;
  // Index structural pairs once, so nested bodies and initializers can be skipped in O(1).
  const pairs = new Map<number, number>(); const stack: number[] = [];
  const closes: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < lex.length; i++) {
    const v = value(i);
    if (v && ['(', '[', '{'].includes(v)) stack.push(i);
    else if (v && closes[v] && value(stack.at(-1) ?? -1) === closes[v]) pairs.set(stack.pop()!, i);
  }
  const keep = (text: string) => {
    const normalized = normalize(text);
    if (normalized.length > 2000) note('API signature cap: 2000 characters kept for comparison.');
    return normalized.slice(0, 2000);
  };
  const add = (name: string, text: string, line: number, renamed = text, comparison?: string) => {
    if (result.length >= 2000) { note('API export cap: 2000 exports per file.'); return; }
    const signature = comparison === undefined ? keep(text) : normalize(text);
    result.push({ name, signature: signature.slice(0, 300), comparisonSignature: comparison ?? signature,
      renameSignature: comparison === undefined ? keep(renamed) : renamed, line });
  };
  // Braces belonging to types are groups; a declaration's implementation body is not.
  const headerEnd = (begin: number, mode: 'header' | 'type' | 'interface' | 'expression' = 'header'): number => {
    let angle = 0;
    for (let j = begin; j < lex.length; j++) {
      const t = lex[j]!; const v = value(j); const previous = value(j - 1);
      if (!angle && j > begin && t.line > lex[j - 1]!.line
        && (mode === 'type' || mode === 'expression' || v === 'export')) return j;
      if (v === '<') { angle++; continue; }
      if (v === '>' && previous !== '=' && angle) { angle--; continue; }
      if (v === '(' || v === '[' || v === '{') {
        const typeBrace = mode === 'type' || angle > 0 || [':', '|', '&', '=>'].includes(previous ?? '')
          || mode !== 'expression' && previous === '>' && value(j - 2) === '=';
        if (v === '{' && mode !== 'interface' && !typeBrace) return j;
        const end = pairs.get(j);
        if (end === undefined) { note('API declaration has an unclosed group.'); return lex.length; }
        j = end;
        if (v === '{' && mode === 'interface' && !angle) return j + 1;
        continue;
      }
      if (!angle && (v === ';' || v === '}' || v === ',' || v === '=' && value(j + 1) !== '>' && mode === 'header')) return j;
    }
    if (angle) note('API declaration has an unclosed generic group.');
    return lex.length;
  };
  const endOffset = (end: number) => lex[end]?.start ?? source.length;
  const text = (begin: number, end: number) => source.slice(lex[begin]!.start, endOffset(end));
  const commonUnknown = () => notes.add(`CommonJS export form not understood: ${file}`);
  const rhs = (begin: number, name: string, line: number) => {
    if (!lex[begin]) { commonUnknown(); return; }
    const end = headerEnd(begin, 'expression');
    if (end === begin) { commonUnknown(); return; }
    add(name, text(begin, end), line);
  };
  const objectExports = (begin: number) => {
    const end = pairs.get(begin);
    if (end === undefined) { commonUnknown(); return lex.length; }
    for (let j = begin + 1; j < end;) {
      if (value(j) === ',') { j++; continue; }
      const start = j;
      let name = lex[j]!;
      if (['get', 'set', 'async'].includes(name.value) && isName(lex[j + 1]) && value(j + 2) === '(') name = lex[++j]!;
      if (!(isName(name) || name.quoted && !source.slice(name.start, name.end).startsWith('`'))
        || ![',', '}', ':', '('].includes(value(j + 1) ?? '')) commonUnknown();
      else {
        const last = headerEnd(start, 'expression');
        add(name.value, text(start, Math.min(last, end)), name.line,
          source.slice(lex[start]!.start, name.start) + '<name>' + source.slice(name.end, endOffset(Math.min(last, end))));
      }
      // Advance to the next shallow property, never to a comma inside a value/body.
      for (; j < end && value(j) !== ','; j++) {
        const close = pairs.get(j);
        if (close !== undefined) j = close;
      }
      j++;
    }
    return end;
  };
  const declarations = new Set(['function', 'class', 'const', 'let', 'var', 'type', 'interface', 'enum', 'namespace', 'import']);
  for (let i = 0; i < lex.length; i++) {
    const start = lex[i]!;
    if (start.quoted) continue;
    if (value(i) === 'Object' && value(i + 1) === '.' && value(i + 2) === 'defineProperty' && value(i + 3) === '(') {
      let target = i + 4;
      if (value(target) === 'module' && value(target + 1) === '.') target += 2;
      if (value(target) === 'exports' && value(target + 1) === ',' && lex[target + 2]?.quoted) {
        const name = lex[target + 2]!;
        add(name.value, `Object.defineProperty(exports, ${JSON.stringify(name.value)})`, start.line, 'Object.defineProperty(exports, <name>)');
        i = target + 2; continue;
      }
    }
    const module = value(i) === 'module' && value(i + 1) === '.' && value(i + 2) === 'exports';
    if (module || value(i) === 'exports' && value(i + 1) === '.') {
      let cursor = module ? i + 3 : i + 1;
      if (value(cursor) === '.' && isName(lex[cursor + 1]) && value(cursor + 2) === '=') {
        rhs(cursor + 3, lex[cursor + 1]!.value, start.line);
        i = cursor + 2;
      } else if (module && value(cursor) === '=') {
        cursor++;
        if (value(cursor) === '{') i = objectExports(cursor);
        else { rhs(cursor, 'module.exports', start.line); i = cursor - 1; }
      } else { commonUnknown(); i = cursor - 1; }
      continue;
    }
    if (start.value !== 'export') continue;
    const begin = i;
    let cursor = i + 1;
    const isDefault = value(cursor) === 'default';
    if (isDefault) cursor++;
    while (['declare', 'async', 'abstract'].includes(value(cursor) ?? '')) cursor++;
    if (value(cursor) === 'const' && value(cursor + 1) === 'enum') cursor++;
    const typeOnly = value(cursor) === 'type' && value(cursor + 1) === '{';
    if (typeOnly) cursor++;
    const next = value(cursor);
    if (next === '{') {
      const end = pairs.get(cursor);
      if (end === undefined || lex[end]!.end - start.start > 4096) {
        note(end === undefined ? 'API export list is unclosed (4096-character list cap).' : 'API export list cap: 4096 characters.');
        i = end ?? lex.length; continue;
      }
      const signature = text(begin, end + 1);
      const spec = value(end + 1) === 'from' && lex[end + 2]?.quoted ? lex[end + 2]!.value : undefined;
      for (let j = cursor + 1; j < end;) {
        if (value(j) === ',') { j++; continue; }
        const bindingType = value(j) === 'type' && isName(lex[j + 1]) && value(j + 1) !== 'as';
        if (bindingType) j++;
        const original = lex[j++]!;
        let exported = original;
        if (value(j) === 'as') { exported = lex[j + 1] ?? original; j += 2; }
        if (isName(exported)) add(exported.value, signature, start.line,
          `export { ${original === exported ? '<name>' : original.value} as <name> } from ${JSON.stringify(spec)}`,
          JSON.stringify([original.value, exported.value, spec, typeOnly || bindingType]));
        else note('API export binding not understood.');
        while (j < end && value(j) !== ',') j++;
      }
      i = end; continue;
    }
    if (next === '*') {
      const namespace = value(cursor + 1) === 'as' ? lex[cursor + 2] : undefined;
      const from = namespace ? cursor + 3 : cursor + 1;
      const spec = value(from) === 'from' ? lex[from + 1] : undefined;
      if (spec?.quoted) {
        const signature = text(begin, from + 2);
        add(namespace?.value ?? `*:${spec.value}`, signature, start.line,
          namespace ? `export * as <name> from ${JSON.stringify(spec.value)}` : signature);
        i = from + 1;
      } else note('API re-export form not understood.');
      continue;
    }
    if (next === '=') { rhs(cursor + 1, 'export=', start.line); i = cursor; continue; }
    if (next === 'as' && value(cursor + 1) === 'namespace' && isName(lex[cursor + 2])) {
      const name = lex[cursor + 2]!;
      add(name.value, text(begin, cursor + 3), start.line, 'export as namespace <name>');
      i = cursor + 2; continue;
    }
    if (!isDefault && !declarations.has(next ?? '')) { note('API export form not understood.'); continue; }
    const nameIndex = value(cursor + 1) === '*' ? cursor + 2 : cursor + 1;
    const nameToken = lex[nameIndex];
    if (!isDefault && !isName(nameToken)) { note('API export declaration name not understood.'); continue; }
    const mode = next === 'type' ? 'type' : next === 'interface' ? 'interface' : next === 'import' ? 'expression' : 'header';
    const end = headerEnd(cursor, mode);
    const signature = text(begin, end);
    const renamed = !isDefault && nameToken
      ? source.slice(start.start, nameToken.start) + '<name>' + source.slice(nameToken.end, endOffset(end)) : signature;
    add(isDefault ? 'default' : nameToken!.value, signature, start.line, renamed);
    i = Math.max(cursor, end - 1);
    if (!isDefault && ['const', 'let', 'var'].includes(next ?? '')) {
      for (let j = end; j < lex.length; j++) {
        if (value(j) === ';' || value(j) === 'export'
          || lex[j]!.line > lex[j - 1]!.line && ['const', 'let', 'var', 'function', 'class'].includes(value(j) ?? '')) { i = j - 1; break; }
        const close = pairs.get(j);
        if (close !== undefined) { j = close; i = j; continue; }
        if (value(j) === ',') {
          const binding = lex[j + 1];
          if (!isName(binding)) { note('API variable binding not understood.'); continue; }
          const last = headerEnd(j + 1);
          add(binding!.value, `export ${next} ${text(j + 1, last)}`, binding!.line,
            `export ${next} <name>${source.slice(binding!.end, endOffset(last))}`);
          j = last - 1;
        }
        i = j;
      }
    }
  }
  return { exports: result, notes: [...notes], incomplete: notes.size > 0 };
}

export function compareApi(base: Map<string, string>, head: Map<string, string>, basePackage: Record<string, unknown> = {}, headPackage: Record<string, unknown> = {}): ApiEvidence {
  const changes: ApiChange[] = []; const notes = new Set<string>(); const unscanned: string[] = [];
  let incomplete = false;
  for (const file of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    if (unsupportedSource(file)) {
      unscanned.push(file); notes.add(`public API not checked for ${file} (language not supported)`); continue;
    }
    const before = scanFile(base.get(file) ?? '', file);
    const after = scanFile(head.get(file) ?? '', file);
    for (const scan of [before, after]) { incomplete ||= scan.incomplete; scan.notes.forEach(note => notes.add(note)); }
    const group = (items: ApiExport[]) => {
      const groups = new Map<string, ApiExport[]>();
      for (const item of items) { const list = groups.get(item.name) ?? []; list.push(item); groups.set(item.name, list); }
      return groups;
    };
    const old = group(before.exports); const current = group(after.exports);
    const added = after.exports.filter(item => !old.has(item.name));
    for (const [name, previous] of old) {
      const next = current.get(name) ?? [];
      const overloads = previous.length > 1 || next.length > 1 ? { before: previous.length, after: next.length } : undefined;
      // Consume exact matches by count, not by declaration position.
      const bySignature = new Map<string, ApiExport[]>();
      for (const item of next) {
        const key = item.comparisonSignature ?? item.signature;
        const list = bySignature.get(key) ?? []; list.push(item); bySignature.set(key, list);
      }
      const removed = previous.filter(item => !bySignature.get(item.comparisonSignature ?? item.signature)?.pop());
      const remaining = [...bySignature.values()].flat();
      for (const item of removed) {
        const found = remaining.shift();
        if (found) changes.push({ file, name, kind: 'changed', before: item.signature, after: found.signature, line: found.line, breaking: true, overloads });
        else {
          const rename = previous.length === 1 ? added.find(candidate => current.get(candidate.name)?.length === 1 && candidate.renameSignature === item.renameSignature) : undefined;
          if (rename) {
            added.splice(added.indexOf(rename), 1);
            changes.push({ file, name: rename.name, previousName: name, kind: 'renamed', before: item.signature, after: rename.signature, line: rename.line, breaking: true });
          } else changes.push({ file, name, kind: 'removed', before: item.signature, line: item.line, breaking: true, overloads });
        }
      }
      for (const item of remaining) changes.push({ file, name, kind: 'added', after: item.signature, line: item.line, breaking: false, overloads });
    }
    for (const item of added) changes.push({ file, name: item.name, kind: 'added', after: item.signature, line: item.line, breaking: false,
      ...(current.get(item.name)!.length > 1 ? { overloads: { before: 0, after: current.get(item.name)!.length } } : {}) });
  }
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
  };
  const packageChanges = ['main', 'module', 'types', 'exports', 'bin', 'version']
    .filter(field => (field === 'exports' ? JSON.stringify(basePackage[field]) !== JSON.stringify(headPackage[field])
      : stable(basePackage[field]) !== stable(headPackage[field])))
    .map(field => ({ field, before: basePackage[field], after: headPackage[field] }));
  return { changes, packageChanges, breaking: packageChanges.length > 0 || changes.some(change => change.breaking), notes: [...notes], incomplete, unscanned };
}
