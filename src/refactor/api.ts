export interface ApiExport { name: string; signature: string; line: number; renameSignature: string; comparisonSignature?: string }
export interface ApiChange {
  file: string; name: string; kind: 'added' | 'removed' | 'changed' | 'renamed';
  before?: string; after?: string; previousName?: string; line: number; breaking: boolean;
}
export interface PackageChange { field: string; before: unknown; after: unknown }
export interface ApiEvidence { changes: ApiChange[]; packageChanges: PackageChange[]; breaking: boolean; notes: string[] }
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
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);

export function scanExports(input: string): ApiExport[] {
  const source = input.slice(0, 64 * 1024);
  const lex = tokens(source); const result: ApiExport[] = [];
  const declarations = new Set(['function', 'class', 'const', 'let', 'var', 'type', 'interface', 'enum', 'namespace']);
  for (let i = 0; i < lex.length; i++) {
    const start = lex[i]!;
    if (start.quoted || start.value !== 'export') continue;
    let next = lex[++i]; if (!next) break;
    if (next.value === 'declare' || next.value === 'async') next = lex[++i];
    if (!next) break;
    const typeOnly = next.value === 'type' && lex[i + 1]?.value === '{';
    if (typeOnly) next = lex[++i]!;
    if (next.value === '{') {
      const begin = i; let end = i + 1;
      while (end < lex.length && lex[end]!.value !== '}' && lex[end]!.start - start.start <= 4096) end++;
      if (lex[end]?.value !== '}') { i = end; continue; }
      const signature = normalize(source.slice(start.start, lex[end]!.end));
      const spec = lex[end + 1]?.value === 'from' && lex[end + 2]?.quoted ? lex[end + 2]!.value : undefined;
      for (let j = begin + 1; j < end;) {
        if (lex[j]!.value === ',') { j++; continue; }
        const bindingType = lex[j]!.value === 'type' && /^[A-Za-z_$][\w$]*$/.test(lex[j + 1]?.value ?? '') && lex[j + 1]?.value !== 'as';
        if (bindingType) j++;
        const original = lex[j++]!;
        let exported = original;
        if (lex[j]?.value === 'as') { exported = lex[j + 1] ?? original; j += 2; }
        if (/^[A-Za-z_$][\w$]*$/.test(exported.value)) result.push({
          name: exported.value, signature, line: start.line,
          renameSignature: normalize(`export { ${original === exported ? '<name>' : original.value} as <name> } from ${JSON.stringify(spec)}`),
          comparisonSignature: JSON.stringify([original.value, exported.value, spec, typeOnly || bindingType]),
        });
        while (j < end && lex[j]!.value !== ',') j++;
      }
      i = end; continue;
    }
    if (next.value === '*') {
      const namespace = lex[i + 1]?.value === 'as' ? lex[i + 2] : undefined;
      const from = namespace ? i + 3 : i + 1;
      const spec = lex[from]?.value === 'from' ? lex[from + 1] : undefined;
      if (spec?.quoted) {
        const signature = normalize(source.slice(start.start, spec.end));
        result.push({ name: namespace?.value ?? `*:${spec.value}`, signature, line: start.line,
          renameSignature: namespace ? `export * as <name> from ${JSON.stringify(spec.value)}` : signature });
        i = from + 1;
      }
      continue;
    }
    const isDefault = next.value === 'default';
    if (!isDefault && !declarations.has(next.value)) continue;
    const nameToken = isDefault ? next : lex[i + 1]?.value === '*' ? lex[i + 2] : lex[i + 1];
    if (!nameToken || !/^[A-Za-z_$][\w$]*$/.test(nameToken.value)) continue;
    let end = nameToken.end;
    while (end < source.length && !'{=;\r\n'.includes(source[end]!)) end++;
    const signature = normalize(source.slice(start.start, end));
    const renamed = source.slice(start.start, nameToken.start) + '<name>' + source.slice(nameToken.end, end);
    result.push({ name: isDefault ? 'default' : nameToken.value, signature, renameSignature: normalize(renamed), line: start.line });
    while (lex[i + 1] && lex[i + 1]!.start < end) i++;
    if (!isDefault && ['const', 'let', 'var'].includes(next.value)) {
      let depth = 0;
      for (let j = i + 1; j < lex.length; j++) {
        const token = lex[j]!;
        if (token.quoted) { i = j; continue; }
        if (depth === 0 && (token.value === ';' || token.line > start.line && ['export', 'const', 'let', 'var', 'function', 'class'].includes(token.value))) { i = j - 1; break; }
        if (['(', '[', '{'].includes(token.value)) depth++;
        if ([')', ']', '}'].includes(token.value)) depth--;
        if (depth < 0) break;
        if (depth === 0 && token.value === ',') {
          const binding = lex[j + 1];
          if (binding && /^[A-Za-z_$][\w$]*$/.test(binding.value)) {
            let last = binding.end;
            while (last < source.length && !'{=;,\r\n'.includes(source[last]!)) last++;
            const text = normalize(`export ${next.value} ${source.slice(binding.start, last)}`);
            result.push({ name: binding.value, signature: text, line: binding.line,
              renameSignature: normalize(`export ${next.value} <name>${source.slice(binding.end, last)}`) });
          }
        }
        i = j;
      }
    }
  }
  return result;
}

export function compareApi(base: Map<string, string>, head: Map<string, string>, basePackage: Record<string, unknown> = {}, headPackage: Record<string, unknown> = {}): ApiEvidence {
  const changes: ApiChange[] = [];
  for (const file of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const before = scanExports(base.get(file) ?? '');
    const after = scanExports(head.get(file) ?? '');
    const old = new Map(before.map(item => [item.name, item]));
    const current = new Map(after.map(item => [item.name, item]));
    const added = after.filter(item => !old.has(item.name));
    for (const item of before) {
      const found = current.get(item.name);
      if (found) {
        if ((found.comparisonSignature ?? found.signature) !== (item.comparisonSignature ?? item.signature)) changes.push({ file, name: item.name, kind: 'changed', before: item.signature, after: found.signature, line: found.line, breaking: true });
      } else {
        const rename = added.find(candidate => candidate.renameSignature === item.renameSignature);
        if (rename) {
          added.splice(added.indexOf(rename), 1);
          changes.push({ file, name: rename.name, previousName: item.name, kind: 'renamed', before: item.signature, after: rename.signature, line: rename.line, breaking: true });
        } else changes.push({ file, name: item.name, kind: 'removed', before: item.signature, line: item.line, breaking: true });
      }
    }
    for (const item of added) changes.push({ file, name: item.name, kind: 'added', after: item.signature, line: item.line, breaking: false });
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
  return { changes, packageChanges, breaking: packageChanges.length > 0 || changes.some(change => change.breaking), notes: [] };
}
