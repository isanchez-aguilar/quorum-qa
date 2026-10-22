export interface ApiExport {
  name: string; signature: string; line: number; renameSignature: string; comparisonSignature?: string;
  headerSignature?: string; members?: ApiExport[]; localSignatures?: Record<string, string>;
}
export interface ApiChange {
  file: string; name: string; kind: 'added' | 'removed' | 'changed' | 'renamed';
  before?: string; after?: string; previousName?: string; line: number; breaking: boolean;
  overloads?: { before: number; after: number }; detail?: string;
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
    if (char === '/' && [';', '{', '}', '=', '(', '[', ':', ',', 'return', 'throw', 'yield', 'await', 'void', 'typeof', 'delete', 'case', '!', '?', '>', '&', '|', '+', '-', '*', '%', '~', '^'].includes(result.at(-1)?.value ?? '=')) {
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
      // An iterative stack keeps nested template expressions opaque to the
      // declaration lexer, without recursion on adversarial nesting.
      const quoted: Array<{ quote: string; braces: number }> = [{ quote: char, braces: 0 }];
      while (i < source.length && quoted.length) {
        const frame = quoted.at(-1)!; const current = source[i]!;
        if (current === '\n') line++;
        if (frame.quote) {
          if (current === '\\') { if (source[i + 1] === '\n') line++; i += 2; continue; }
          if (current === frame.quote) { quoted.pop(); i++; continue; }
          if (frame.quote === '`' && current === '$' && source[i + 1] === '{') {
            quoted.push({ quote: '', braces: 1 }); i += 2; continue;
          }
        } else {
          if (current === '"' || current === "'" || current === '`') quoted.push({ quote: current, braces: 0 });
          else if (current === '{') frame.braces++;
          else if (current === '}' && --frame.braces === 0) quoted.pop();
          else if (current === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i++;
            continue;
          } else if (current === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
              if (source[i] === '\n') line++; i++;
            }
            i = Math.min(source.length, i + 2); continue;
          }
        }
        i++;
      }
      result.push({ value: source.slice(start + 1, quoted.length ? i : i - 1), start, end: i, line: startLine, quoted: true });
    } else if (identifier(char)) {
      while (i < source.length && identifier(source[i]!)) i++;
      result.push({ value: source.slice(start, i), start, end: i, line });
    } else { i++; result.push({ value: char, start, end: i, line }); }
  }
  return result;
}
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const isName = (token?: Token) => !!token && !token.quoted && /^[A-Za-z_$][\w$]*$/.test(token.value);
interface ScanResult { exports: ApiExport[]; notes: string[]; incomplete: boolean; exportLines: Set<string>; semanticSource: string }
const tokenKey = (token: Token) => token.quoted ? JSON.stringify(token.value) : token.value;
const canonical = (text: string) => tokens(text).map(tokenKey).join(' ');

/** Public convenience API; comparison also consumes the scanner's coverage diagnostics. */
export function scanExports(input: string): ApiExport[] { return scanFile(input, '<input>').exports; }

function scanFile(input: string, file: string): ScanResult {
  const notes = new Set<string>();
  const note = (reason: string) => notes.add(`${file}: ${reason}`);
  const bytes = Buffer.from(input);
  if (bytes.length > API_INPUT_BYTES) note('API input cap: 256 KiB per file.');
  const source = bytes.subarray(0, API_INPUT_BYTES).toString('utf8');
  const lex = tokens(source); const result: ApiExport[] = [];
  const implementation = new Set<number>();
  const ignoreImplementation = (begin: number, end: number) => {
    for (let j = begin; j < end; j++) implementation.add(j);
  };
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
    result.push({ name, signature: signature.slice(0, 300), comparisonSignature: comparison ?? keep(canonical(text)),
      renameSignature: comparison === undefined ? keep(canonical(renamed)) : renamed, line });
  };
  // Braces belonging to types are groups; a declaration's implementation body is not.
  const headerEnd = (begin: number, mode: 'header' | 'type' | 'interface' | 'expression' = 'header'): number => {
    let angle = 0;
    for (let j = begin; j < lex.length; j++) {
      const t = lex[j]!; const v = value(j); const previous = value(j - 1);
      if (!angle && j > begin && t.line > lex[j - 1]!.line
        && (mode === 'expression' || v === 'export'
          || mode === 'type' && previous !== '='
          && !['|', '&', '?', ':', '.', '(', '[', '{', '<'].includes(v ?? '')
          && !(v === '=' && value(j + 1) === '>'))) return j;
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
  const key = (begin: number, end: number) => lex.slice(begin, end).map(tokenKey).join(' ');
  const renamedKey = (signature: string, name: string) => {
    const token = tokens(signature).find(token => isName(token) && token.value === name);
    return token ? signature.slice(0, token.start) + '<name>' + signature.slice(token.end) : signature;
  };
  // Only an initializer's callable header is API. Groups are skipped through
  // the shared pair index, never searched again for every nested parameter.
  const arrowHeader = (begin: number, limit = lex.length): number | undefined => {
    let j = begin;
    if (value(j) === 'async') j++;
    if (value(j) === '<') {
      let angle = 1;
      for (j++; j < limit && angle; j++) {
        if (value(j) === '<') angle++;
        if (value(j) === '>' && value(j - 1) !== '=') angle--;
        const close = pairs.get(j);
        if (close !== undefined) j = close;
      }
    }
    if (value(j) === '(' && pairs.has(j)) j = pairs.get(j)! + 1;
    else if (isName(lex[j])) j++;
    else return undefined;
    if (value(j) === '=' && value(j + 1) === '>') return j;
    if (value(j) !== ':') return undefined;
    let angle = 0;
    for (j++; j < limit; j++) {
      if (value(j) === '<') angle++;
      if (value(j) === '>' && value(j - 1) !== '=' && angle) angle--;
      if (!angle && value(j) === '=' && value(j + 1) === '>') {
        if (value(j - 1) === ')') {
          note('API arrow return type is ambiguous; initializer text retained.');
          const end = statementEnd(begin, limit);
          return value(end - 1) === ';' ? end - 1 : end;
        }
        return j;
      }
      if (value(j) === ';' || !angle && value(j) === ',') break;
      const close = pairs.get(j);
      if (close !== undefined) j = close;
    }
    return undefined;
  };
  const initializerEnd = (end: number, kind: string): number => {
    if (value(end) !== '=') return end;
    const arrow = arrowHeader(end + 1);
    if (arrow !== undefined) return arrow;
    if (kind === 'const' && ['{', '['].includes(value(end + 1) ?? '')) {
      const close = pairs.get(end + 1);
      if (close !== undefined && (value(close + 1) === 'as' && value(close + 2) === 'const'
        || value(close + 1) === 'satisfies')) return headerEnd(close + 1, 'type');
    }
    return end;
  };
  const variableSignature = (begin: number, end: number, kind: string) => {
    const last = initializerEnd(end, kind);
    const signature = key(begin, last);
    const cap = last !== end ? 8000 : 2000;
    if (signature.length >= cap) note(`API signature cap: ${cap} characters kept for comparison.`);
    return signature.slice(0, cap);
  };
  const skeletonKinds = new Set(['class', 'interface', 'enum', 'namespace', 'module']);
  const declarationKinds = new Set([...skeletonKinds, 'function', 'const', 'let', 'var', 'type', 'import']);
  const modifiers = new Set(['export', 'default', 'declare', 'abstract', 'async']);
  const memberModifiers = new Set(['public', 'private', 'protected', 'static', 'readonly', 'abstract', 'async', 'declare', 'override', 'accessor']);
  const statementEnd = (begin: number, limit = lex.length) => {
    for (let j = begin; j < limit; j++) {
      if (value(j) === ';') return j + 1;
      if (j > begin && lex[j]!.line > lex[j - 1]!.line) return j;
      const close = pairs.get(j);
      if (close !== undefined) j = close;
    }
    return limit;
  };
  interface Declaration { begin: number; cursor: number; nameIndex: number; end: number; importEnd?: number; exported?: boolean }
  // Only shallow declarations enter a scope table. Groups are indexed and skipped,
  // including function bodies, so an inner binding can never resolve an outer export.
  const scopeTable = (begin: number, limit: number) => {
    const table = new Map<string, Declaration[]>();
    const record = (name: string, item: Declaration) => {
      item.exported ??= value(item.begin) === 'export';
      const list = table.get(name) ?? []; list.push(item); table.set(name, list);
    };
    for (let j = begin; j < limit; j++) {
      const first = j;
      while (modifiers.has(value(j) ?? '')) j++;
      if (value(j) === 'const' && value(j + 1) === 'enum') j++;
      const kind = value(j);
      if (kind === 'import') {
        const end = statementEnd(j, limit);
        // Names preceding `from` (or `=` for TS import aliases) are bindings.
        for (let k = j + 1; k < end && value(k) !== 'from' && value(k) !== '='; k++) {
          if (isName(lex[k]) && !['type', 'as'].includes(value(k)!)
            && value(k + 1) !== 'as') record(value(k)!, { begin: first, cursor: j, nameIndex: k, end, importEnd: end });
        }
        j = end - 1; continue;
      }
      if (declarationKinds.has(kind ?? '')) {
        const nameIndex = value(j + 1) === '*' ? j + 2 : j + 1;
        if (isName(lex[nameIndex])) {
          let end = headerEnd(j, kind === 'type' ? 'type' : kind === 'interface' ? 'interface' : 'header');
          if (value(end) === '{') end = (pairs.get(end) ?? limit - 1) + 1;
          record(value(nameIndex)!, { begin: first, cursor: j, nameIndex, end });
          if (['const', 'let', 'var'].includes(kind!)) {
            // Each declarator has its own annotation; initializer commas in groups
            // are skipped rather than mistaken for a second binding.
            const initializer = end;
            for (let k = end; k < limit; k++) {
              if (value(k) === ';') { end = k + 1; break; }
              if (k > initializer && lex[k]!.line > lex[k - 1]!.line
                && !['=', ',', '|', '&', '+', '-', '>', '.'].includes(value(k - 1) ?? '')) { end = k; break; }
              if (value(k) === 'export') { end = k; break; }
              if (value(k) === ',' && isName(lex[k + 1])) {
                const last = headerEnd(k + 1);
                record(value(k + 1)!, { begin: k + 1, cursor: j, nameIndex: k + 1, end: last, exported: value(first) === 'export' });
              }
              const close = pairs.get(k);
              if (close !== undefined) k = close;
              end = k + 1;
            }
          }
          j = Math.max(j, end - 1); continue;
        }
      }
      const close = pairs.get(j);
      if (close !== undefined) j = close;
      else if (value(j) === '{') break;
    }
    return table;
  };
  const locals = scopeTable(0, lex.length);
  interface Scope { table: Map<string, Declaration[]>; parent?: Scope }
  const fileScope: Scope = { table: locals };
  const namespaceExports = new WeakSet<ApiExport>();
  const typeKinds = new Set(['type', 'interface', 'enum', 'class']);
  const localCache = new WeakMap<Declaration[], { signature: string; references: string[] }>();
  // Resolve each dependency in its declaration's lexical scope, including shadowing.
  // Namespace members are expanded before their enclosing skeleton is assembled.
  const expandLocalTypes = (items: ApiExport[], scope: Scope) => {
    const lookup = (name: string, from: Scope): { declarations: Declaration[]; scope: Scope } | undefined => {
      for (let current: Scope | undefined = from; current; current = current.parent) {
        const declarations = current.table.get(name);
        if (declarations) return declarations.some(decl => !decl.exported && typeKinds.has(value(decl.cursor)!))
          ? { declarations, scope: current } : undefined;
      }
      return undefined;
    };
    const namesIn = (signature: string) => [...new Set(tokens(signature).filter(isName).map(token => token.value))];
    for (const item of items) {
      if (namespaceExports.has(item)) continue;
      const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
      const visited = new Set<Declaration[]>();
      let remaining = 8000;
      const visit = (name: string, from: Scope, depth: number) => {
        const found = lookup(name, from);
        if (!found || visited.has(found.declarations)) return;
        if (depth > 4) { note('API local reference depth cap: 4 levels.'); return; }
        if (remaining <= 0) { note('API local reference cap: 8000 characters.'); return; }
        visited.add(found.declarations);
        let cached = localCache.get(found.declarations);
        if (!cached) {
          const signature = found.declarations.map(decl => capture(decl, undefined, found.scope).comparisonSignature!).join(' ; ');
          cached = { signature, references: namesIn(signature) };
          localCache.set(found.declarations, cached);
        }
        // Distinct lexical bindings can share a name along a dependency chain.
        const label = Object.hasOwn(dependencies, name) ? name + '#' + visited.size : name;
        dependencies[label] = cached.signature.slice(0, remaining);
        if (cached.signature.length >= remaining) note('API local reference cap: 8000 characters.');
        remaining -= cached.signature.length;
        for (const other of cached.references) visit(other, found.scope, depth + 1);
      };
      for (const name of namesIn(item.comparisonSignature!)) visit(name, scope, 1);
      if (visited.size) {
        item.localSignatures = dependencies;
        const suffix = JSON.stringify(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
        item.comparisonSignature += suffix;
        item.renameSignature += suffix;
        if (item.headerSignature !== undefined) item.headerSignature += suffix;
      }
    }
  };
  interface CaptureBudget { remaining: number; depth: number }
  const consume = (signature: string, budget: CaptureBudget) => {
    if (signature.length >= budget.remaining) note('API skeleton cap: 8000 characters kept for comparison.');
    const kept = signature.slice(0, budget.remaining);
    budget.remaining = Math.max(0, budget.remaining - signature.length);
    return kept;
  };
  const memberName = (begin: number, end: number) => {
    let j = begin;
    while (j + 1 < end && memberModifiers.has(value(j) ?? '') && !['(', ':', '?', '=', ';'].includes(value(j + 1) ?? '')) j++;
    if (['get', 'set'].includes(value(j) ?? '') && isName(lex[j + 1])) j++;
    if (value(j) === '*') j++;
    if (value(j) === '[') return key(j, (pairs.get(j) ?? j) + 1);
    return lex[j]?.quoted ? lex[j]!.value : value(j) ?? '<call>';
  };
  const makeExport = (name: string, signature: string, line: number, headerSignature?: string, members?: ApiExport[]): ApiExport => ({
    name, signature: signature.slice(0, 300), comparisonSignature: signature, renameSignature: signature,
    line, headerSignature, members,
  });
  const capture = (decl: Declaration, budget: CaptureBudget = { remaining: 8000, depth: 0 }, scope: Scope = fileScope): ApiExport => {
    const { cursor, nameIndex } = decl;
    const kind = value(cursor)!;
    const name = lex[nameIndex]!.value;
    const begin = decl.begin;
    const mode = kind === 'type' ? 'type' : kind === 'interface' ? 'interface' : kind === 'import' ? 'expression' : 'header';
    const end = decl.importEnd ?? headerEnd(nameIndex + 1, mode);
    let body = -1;
    if (skeletonKinds.has(kind) || kind === 'type') {
      let angle = 0;
      for (let j = value(nameIndex) === '{' || value(nameIndex) === '<' ? nameIndex : nameIndex + 1; j < lex.length; j++) {
        const v = value(j);
        if (v === '<') angle++;
        if (v === '>' && value(j - 1) !== '=' && angle) angle--;
        if (!angle && v === '{') { body = j; break; }
        if (!angle && (v === ';' || v === 'export')) break;
        if (kind === 'type' && !angle && v === '=' && value(j + 1) !== '{') break;
        const close = pairs.get(j);
        if (close !== undefined) j = close;
      }
    }
    if (body < 0) {
      const prefix = nameIndex > cursor + 1 && value(cursor + 1) !== '*' ? key(cursor, cursor + 1) : key(begin, nameIndex);
      if (['const', 'let', 'var'].includes(kind)) {
        const signature = prefix + ' ' + variableSignature(nameIndex, end, kind);
        return makeExport(name, consume(signature, budget), lex[begin]!.line);
      }
      const signature = decl.importEnd ? key(cursor, end) : prefix + ' ' + key(nameIndex, end);
      return makeExport(name, budget.depth ? consume(keep(signature), budget) : keep(signature), lex[begin]!.line);
    }
    const close = pairs.get(body);
    if (close === undefined) note('API declaration has an unclosed group.');
    const limit = close ?? lex.length;
    const suffix = kind === 'type' && close !== undefined ? key(close + 1, end) : '';
    const header = consume(key(begin, body) + (suffix ? ` ${suffix}` : ''), budget);
    const members: ApiExport[] = [];
    if (budget.depth >= 32) { note('API skeleton nesting cap: 32 declaration levels.'); budget.remaining = 0; }
    const namespace = kind === 'namespace' || kind === 'module';
    if (namespace && budget.remaining) {
      const table = scopeTable(body + 1, limit);
      const innerScope: Scope = { table, parent: scope };
      for (const declarations of table.values()) for (const child of declarations) {
        if (!child.exported) continue;
        if (!budget.remaining) break;
        budget.depth++;
        members.push(capture(child, budget, innerScope));
        budget.depth--;
      }
      // Namespace export lists resolve in this scope, never in the file's scope.
      for (let j = body + 1; j < limit && budget.remaining; j++) {
        if (value(j) === 'export' && value(j + 1) === '{') {
          const end = pairs.get(j + 1);
          if (end === undefined) { note('API export list is unclosed.'); break; }
          const from = value(end + 1) === 'from' ? lex[end + 2] : undefined;
          for (let k = j + 2; k < end && budget.remaining;) {
            if (value(k) === ',') { k++; continue; }
            const original = value(k++);
            const alias = value(k) === 'as' ? value(k + 1) : original;
            if (value(k) === 'as') k += 2;
            if (!original || !alias) { note('API namespace export binding not understood.'); break; }
            if (from?.quoted) members.push(makeExport(alias, consume(JSON.stringify([original, from.value]), budget), lex[j]!.line));
            else {
              const declarations = table.get(original);
              if (!declarations) {
                note(`API binding ${original} is <unresolved>.`);
                members.push(makeExport(alias, consume('<unresolved>', budget), lex[j]!.line));
              } else for (const declaration of declarations) {
                if (!budget.remaining) break;
                budget.depth++;
                const member = capture(declaration, budget, innerScope);
                member.name = alias;
                members.push(member);
                budget.depth--;
              }
            }
            while (k < end && value(k) !== ',') k++;
          }
          j = end;
        } else if (value(j) === 'export') {
          let cursor = j + 1;
          while (modifiers.has(value(cursor) ?? '')) cursor++;
          if (!declarationKinds.has(value(cursor) ?? '')) note('API namespace export form not understood.');
        }
        const stop = pairs.get(j);
        if (stop !== undefined) j = stop;
      }
      expandLocalTypes(members, innerScope);
    } else if (budget.remaining) {
      let enumNext = 0;
      let enumAnchor = '';
      for (let j = body + 1; j < limit && budget.remaining;) {
        if ([';', ','].includes(value(j) ?? '')) { j++; continue; }
        const first = j;
        if (kind === 'class' && value(j) === 'static' && value(j + 1) === '{') {
          const stop = pairs.get(j + 1);
          if (stop === undefined) note('API member has an unclosed group.');
          j = stop === undefined ? limit : stop + 1; continue;
        }
        let last = j; let next = j;
        let angle = 0; let sawParameters = false; let annotation = false;
        for (; next < limit; next++) {
          const v = value(next);
          if (!angle && next > first && lex[next]!.line > lex[next - 1]!.line
            && ![':', '?', '=', '|', '&', ',', '.', '(', '<'].includes(value(next - 1) ?? '')
            && ![';', ',', '{', '(', '|', '&', '.', '?', ':'].includes(v ?? '')) break;
          if (v === '<') angle++;
          if (v === '>' && value(next - 1) !== '=' && angle) angle--;
          if (!angle && (v === ';' || v === ',')) break;
          if (!angle && v === ':') annotation = true;
          if (!angle && kind === 'class' && v === '=' && value(next + 1) !== '>') {
            const initializer = next;
            const arrow = arrowHeader(next + 1, limit);
            last = arrow ?? initializerEnd(next, 'const');
            // Keep arrow parameters/return annotation, discard its implementation.
            for (next++; next < limit; next++) {
              if (next >= last && [';', ','].includes(value(next) ?? '')
                || next > (arrow === undefined ? initializer + 1 : last + 2)
                  && lex[next]!.line > lex[next - 1]!.line) break;
              const stop = pairs.get(next);
              if (stop !== undefined) next = stop;
            }
            break;
          }
          if (v === '(' && !angle && !annotation) sawParameters = true;
          if (v === '(' || v === '[' || v === '{') {
            const stop = pairs.get(next);
            if (stop === undefined) { note('API member has an unclosed group.'); next = limit; break; }
            const typeBrace = angle > 0 || [':', '|', '&', '='].includes(value(next - 1) ?? '')
              || value(next - 1) === '>' && value(next - 2) === '=';
            if (kind === 'class' && v === '{' && sawParameters && !typeBrace) {
              last = next; next = stop + 1; break;
            }
            next = stop;
          }
          last = next + 1;
        }
        let nameStart = first; let hidden = false;
        while (nameStart + 1 < last && memberModifiers.has(value(nameStart) ?? '')
          && !['(', ':', '?', '=', ';'].includes(value(nameStart + 1) ?? '')) {
          hidden ||= value(nameStart) === 'private'; nameStart++;
        }
        hidden ||= value(nameStart) === '#';
        if (last > first && !hidden) {
          let memberSignature = key(first, last);
          if (kind === 'enum') {
            const initializer = value(first + 1) === '=' ? first + 2 : undefined;
            if (initializer === undefined) {
              if (enumAnchor) note('API enum initializer is not a numeric literal; subsequent implicit values are symbolic.');
              memberSignature += ` = <implicit ${enumAnchor}${enumNext++}>`;
            } else {
              const expression = key(initializer, last);
              const numeric = Number(expression.replace(/\s/g, ''));
              enumNext = Number.isFinite(numeric) ? numeric + 1 : 1;
              enumAnchor = Number.isFinite(numeric) ? '' : `after ${expression} + `;
            }
          }
          const signature = consume(memberSignature, budget);
          members.push(makeExport(memberName(first, last), signature, lex[first]!.line));
        }
        j = Math.max(first + 1, next);
      }
    }
    const sorted = members.map(member => `${JSON.stringify(member.name)}: ${member.comparisonSignature!}`).sort();
    const signature = (header + ' { ' + sorted.join(' ; ') + ' }').slice(0, 8000);
    if (header.length + sorted.join(' ; ').length + 5 >= 8000) note('API skeleton cap: 8000 characters kept for comparison.');
    const item = makeExport(name, signature, lex[begin]!.line, header, members);
    if (namespace) namespaceExports.add(item);
    return item;
  };
  const resolved = new Map<string, ApiExport[]>();
  const resolve = (name: string) => {
    if (resolved.has(name)) return resolved.get(name)!;
    const declarations = locals.get(name);
    const items = declarations?.map(decl => capture(decl)) ?? [];
    if (!items.length) { note(`API binding ${name} is <unresolved>.`); items.push(makeExport(name, '<unresolved>', 1)); }
    resolved.set(name, items);
    return items;
  };
  const addResolved = (name: string, original: string, line: number, typeOnly = false) => {
    for (const item of resolve(original)) {
      if (result.length >= 2000) { note('API export cap: 2000 exports per file.'); break; }
      const exported = { ...item, name, line, comparisonSignature: JSON.stringify([original, typeOnly, item.comparisonSignature]),
        headerSignature: item.headerSignature === undefined ? undefined : JSON.stringify([original, typeOnly, item.headerSignature]) };
      if (namespaceExports.has(item)) namespaceExports.add(exported);
      result.push(exported);
    }
  };
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
  const declarations = declarationKinds;
  for (let i = 0; i < lex.length; i++) {
    const start = lex[i]!;
    if (start.quoted) continue;
    if (value(i) === 'declare' && (value(i + 1) === 'global'
      || value(i + 1) === 'module' && lex[i + 2]?.quoted)) {
      // Ambient bodies have implicit exports and arbitrary merging rules. Keep
      // all their text conservatively and explicitly report the modeling gap.
      const body = value(i + 1) === 'global' ? i + 2 : i + 3;
      const close = pairs.get(body);
      const name = value(i + 1) === 'global' ? 'global' : `module '${lex[i + 2]!.value}'`;
      note(`API ambient augmentation ${name} is conservatively scanned, not resolved.`);
      const signature = key(i, close === undefined ? lex.length : close + 1);
      if (signature.length >= 8000) note('API skeleton cap: 8000 characters kept for comparison.');
      if (result.length >= 2000) note('API export cap: 2000 exports per file.');
      else result.push(makeExport(name, signature.slice(0, 8000), start.line));
      i = close ?? lex.length;
      continue;
    }
    if (value(i) === 'Object' && value(i + 1) === '.' && value(i + 2) === 'assign' && value(i + 3) === '(') {
      let target = i + 4;
      if (value(target) === 'module' && value(target + 1) === '.') target += 2;
      if (value(target) === 'exports') {
        if (value(target + 1) === ',' && value(target + 2) === '{') {
          const end = objectExports(target + 2);
          if (value(end + 1) !== ')') commonUnknown();
          i = end;
        } else { commonUnknown(); i = target; }
        continue;
      }
    }
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
    if (module || value(i) === 'exports' && ['.', '['].includes(value(i + 1) ?? '')) {
      let cursor = module ? i + 3 : i + 1;
      if (value(cursor) === '.' && isName(lex[cursor + 1]) && value(cursor + 2) === '=') {
        rhs(cursor + 3, lex[cursor + 1]!.value, start.line);
        i = cursor + 2;
      } else if (value(cursor) === '[' && lex[cursor + 1]?.quoted
        && !source.slice(lex[cursor + 1]!.start, lex[cursor + 1]!.end).startsWith('`')
        && value(cursor + 2) === ']' && value(cursor + 3) === '=') {
        rhs(cursor + 4, lex[cursor + 1]!.value, start.line);
        i = cursor + 3;
      } else if (module && value(cursor) === '=') {
        cursor++;
        if (value(cursor) === '{') i = objectExports(cursor);
        else { rhs(cursor, 'module.exports', start.line); i = cursor - 1; }
      } else { commonUnknown(); i = cursor - 1; }
      continue;
    }
    if (start.value !== 'export') {
      const close = pairs.get(i);
      if (close !== undefined) i = close;
      continue;
    }
    const begin = i;
    let cursor = i + 1;
    const isDefault = value(cursor) === 'default';
    if (isDefault) cursor++;
    while (['declare', 'async', 'abstract'].includes(value(cursor) ?? '')) cursor++;
    if (value(cursor) === 'const' && value(cursor + 1) === 'enum') cursor++;
    const typeOnly = value(cursor) === 'type' && value(cursor + 1) === '{';
    if (typeOnly) cursor++;
    const next = value(cursor);
    if (isDefault && (next === '(' || next === '<' || isName(lex[cursor]) && !declarations.has(next ?? ''))) {
      // Look only at the outer header: arrows nested in parameter/return types
      // cannot delimit this function's implementation.
      let arrow = cursor;
      let lastArrow = -1;
      let annotated = false;
      let angle = 0;
      for (; arrow < lex.length; arrow++) {
        const v = value(arrow);
        if (v === '<') angle++;
        else if (v === '>' && value(arrow - 1) !== '=' && angle) angle--;
        if (!angle && v === ':' && lastArrow < 0) annotated = true;
        if (!angle && v === '=' && value(arrow + 1) === '>') {
          lastArrow = arrow;
          if (!annotated) break;
        }
        if (v === ';' || v === 'export') break;
        if (lastArrow >= 0 && lex[arrow]!.line > lex[lastArrow]!.line) break;
        if (lastArrow >= 0 && v === '{') break;
        const close = pairs.get(arrow);
        if (close !== undefined) arrow = close;
      }
      if (lastArrow >= 0) arrow = lastArrow;
      if (value(arrow) === '=' && value(arrow + 1) === '>') {
        add('default', text(begin, arrow), start.line);
        const body = arrow + 2;
        const end = pairs.get(body) !== undefined && value(body) === '{'
          ? pairs.get(body)! + 1 : headerEnd(body, 'expression');
        ignoreImplementation(body, end);
        i = Math.max(arrow + 1, end - 1);
        continue;
      }
      if (isName(lex[cursor]) && ([';', undefined].includes(value(cursor + 1))
        || lex[cursor + 1]!.line > lex[cursor]!.line)) {
        addResolved('default', lex[cursor]!.value, start.line);
        i = cursor; continue;
      }
    }
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
        if (isName(exported) && spec === undefined) addResolved(exported.value, original.value, start.line, typeOnly || bindingType);
        else if (isName(exported)) add(exported.value, signature, start.line,
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
    const skeleton = skeletonKinds.has(next ?? '') || next === 'type' ? capture({ begin, cursor, nameIndex, end }) : undefined;
    if (skeleton?.members) {
      const item = skeleton;
      item.name = isDefault ? 'default' : nameToken!.value;
      item.renameSignature = isDefault ? item.comparisonSignature!
        : renamedKey(item.comparisonSignature!, nameToken!.value);
      if (result.length >= 2000) note('API export cap: 2000 exports per file.');
      else result.push(item);
      // Find the declaration's outer body rather than scanning exports inside it twice.
      let body = cursor; let angle = 0;
      for (; body < lex.length; body++) {
        if (value(body) === '<') angle++;
        if (value(body) === '>' && value(body - 1) !== '=' && angle) angle--;
        if (value(body) === '{' && !angle && pairs.has(body)) { i = pairs.get(body)!; break; }
        const close = pairs.get(body);
        if (close !== undefined) body = close;
      }
      if (body === lex.length) i = lex.length;
      continue;
    }
    const signature = text(begin, end);
    const renamed = !isDefault && nameToken
      ? source.slice(start.start, nameToken.start) + '<name>' + source.slice(nameToken.end, endOffset(end)) : signature;
    if (['const', 'let', 'var'].includes(next ?? '')) {
      const kept = variableSignature(begin, end, next!);
      add(isDefault ? 'default' : nameToken!.value, kept, start.line,
        renamedKey(kept, nameToken!.value), kept);
    } else add(isDefault ? 'default' : nameToken!.value, signature, start.line, renamed);
    if (next === 'function' && value(end) === '{' && pairs.has(end)) {
      ignoreImplementation(end + 1, pairs.get(end)!);
    }
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
          const kept = `export ${next} ${variableSignature(j + 1, last, next!)}`;
          add(binding!.value, kept, binding!.line, renamedKey(kept, binding!.value), kept);
          j = last - 1;
        }
        i = j;
      }
    }
  }
  expandLocalTypes(result, fileScope);
  // A second, deliberately broader view catches syntax the declaration scanner
  // does not understand. Comments/spacing are absent; known function bodies are
  // behaviour, so they do not participate even when written on the export line.
  const exportLines = new Set<string>();
  const semanticTokens: string[] = [];
  let line: Token[] = [];
  const flush = () => {
    if (line[0]?.value === 'export' && !line[0].quoted
      || line[0]?.value === 'exports' && !line[0].quoted && ['.', '['].includes(line[1]?.value ?? '')
      || line[0]?.value === 'module' && !line[0].quoted && line[1]?.value === '.' && line[2]?.value === 'exports') {
      let depth = 0;
      const header: Token[] = [];
      for (const token of line) {
        if (!token.quoted && !depth && ['{', '=', ';'].includes(token.value)) break;
        if (!token.quoted && ['(', '[', '<'].includes(token.value)) depth++;
        if (!token.quoted && [')', ']', '>'].includes(token.value)) depth = Math.max(0, depth - 1);
        header.push(token);
      }
      exportLines.add(header.map(tokenKey).join(' '));
    }
    line = [];
  };
  for (let j = 0; j < lex.length; j++) {
    if (line.length && lex[j]!.line !== line[0]!.line) flush();
    if (!implementation.has(j)) {
      line.push(lex[j]!);
      semanticTokens.push(tokenKey(lex[j]!));
    }
  }
  flush();
  return { exports: result, notes: [...notes], incomplete: notes.size > 0, exportLines, semanticSource: semanticTokens.join(' ') };
}

export function compareApi(base: Map<string, string>, head: Map<string, string>, basePackage: Record<string, unknown> = {}, headPackage: Record<string, unknown> = {}): ApiEvidence {
  const changes: ApiChange[] = []; const notes = new Set<string>(); const unscanned: string[] = [];
  const compareMembers = (file: string, name: string, before: ApiExport[], after: ApiExport[]) => {
    const names = new Set([...before, ...after].map(member => member.name));
    const oldGroups = new Map<string, ApiExport[]>(); const newGroups = new Map<string, ApiExport[]>();
    for (const [items, groups] of [[before, oldGroups], [after, newGroups]] as const) {
      for (const item of items) { const list = groups.get(item.name) ?? []; list.push(item); groups.set(item.name, list); }
    }
    for (const member of names) {
      const old = oldGroups.get(member) ?? []; const next = newGroups.get(member) ?? [];
      const signatures = new Map<string, ApiExport[]>();
      for (const item of next) {
        const list = signatures.get(item.comparisonSignature!) ?? [];
        list.push(item); signatures.set(item.comparisonSignature!, list);
      }
      const removed = old.filter(item => !signatures.get(item.comparisonSignature!)?.pop());
      const added = [...signatures.values()].flat();
      const overloads = old.length > 1 || next.length > 1 ? { before: old.length, after: next.length } : undefined;
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        const previous = removed[i]; const current = added[i]; const qualified = `${name}.${member}`;
        if (previous?.members && current?.members && previous.headerSignature === current.headerSignature) {
          compareMembers(file, qualified, previous.members, current.members);
        } else changes.push({ file, name: qualified, kind: previous ? current ? 'changed' : 'removed' : 'added',
          before: previous?.signature, after: current?.signature, line: (current ?? previous)!.line,
          breaking: !!previous, overloads });
      }
    }
  };
  let incomplete = false;
  for (const file of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const changeStart = changes.length;
    if (unsupportedSource(file)) {
      unscanned.push(file); notes.add(`public API not checked for ${file} (language not supported)`); continue;
    }
    const before = scanFile(base.get(file) ?? '', file);
    const after = (base.get(file) ?? '') === (head.get(file) ?? '')
      ? before : scanFile(head.get(file) ?? '', file);
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
        if (found) {
          if (item.members && found.members && item.headerSignature === found.headerSignature) compareMembers(file, name, item.members, found.members);
          else {
            const localNames = new Set([...Object.keys(item.localSignatures ?? {}), ...Object.keys(found.localSignatures ?? {})]);
            const detail = [...localNames].filter(local => item.localSignatures?.[local] !== found.localSignatures?.[local])
              .map(local => `uses ${local}, which changed`).join('; ') || undefined;
            changes.push({ file, name, kind: 'changed', before: item.signature, after: found.signature, line: found.line, breaking: true, overloads, detail });
          }
        }
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
    if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && before.semanticSource !== after.semanticSource) {
      const changedLines = [...before.exportLines].filter(line => !after.exportLines.has(line))
        .concat([...after.exportLines].filter(line => !before.exportLines.has(line)));
      const explained = new Set(changes.slice(changeStart).flatMap(change =>
        [...change.name.split('.'), ...(change.previousName?.split('.') ?? [])]));
      for (const line of changedLines) {
        if (line.split(/\W+/).some(word => explained.has(word))) continue;
        notes.add(`${file}: export-related lines changed but no API change was recognised for: ${line}`);
        incomplete = true;
        if (!unscanned.includes(file)) unscanned.push(file);
      }
    }
  }
  const stable = (value: unknown, ordered = false): string => {
    if (Array.isArray(value)) return `[${value.map(item => stable(item, ordered)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      if (!ordered) keys.sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key], ordered)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  };
  const packageChanges = ['main', 'module', 'types', 'typings', 'exports', 'imports', 'bin', 'version', 'type', 'engines', 'files',
    'sideEffects', 'browser', 'typesVersions', 'peerDependencies', 'workspaces']
    .filter(field => stable(basePackage[field], ['exports', 'imports', 'typesVersions'].includes(field)) !== stable(headPackage[field], ['exports', 'imports', 'typesVersions'].includes(field)))
    .map(field => ({ field, before: basePackage[field], after: headPackage[field] }));
  return { changes, packageChanges, breaking: packageChanges.length > 0 || changes.some(change => change.breaking), notes: [...notes], incomplete, unscanned };
}
