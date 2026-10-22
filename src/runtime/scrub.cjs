'use strict';

// Each pass scans disjoint tokens. No unanchored nested quantifiers on page text.
// Only strings that look like secrets are hidden: hex, or long with several digits, or base64 padding.
// Long identifiers made of words (kebab-case selectors, component names) must stay readable, or two
// different errors would collapse into one signature.
const secretLike = part => part.length >= 64 || part.length >= 24 && (/^[0-9a-fA-F]+$/.test(part) || (part.match(/\d/g) ?? []).length >= 3 || /[+=\/]/.test(part));
// Windows drive, UNC (\\server\share\) and extended (\\?\C:\) paths, and POSIX absolute paths.
const ABSOLUTE = String.raw`(?:[A-Za-z]:[\\/]|\\\\\?\\[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/)`;
const PATH_AT = new RegExp(String.raw`(?:^|[('"=|])${ABSOLUTE}`);
const PATH_START = new RegExp(`^${ABSOLUTE}`);

function scrubForDisplay(text) {
  const tokens = value => value.replace(/[A-Za-z0-9_+\/-]+={0,2}/g, token => secretLike(token) ? '[token]' : token);
  return text.replace(/\S+/g, token => {
    const url = /https?:\/\//i.exec(token);
    if (url) {
      const prefix = token.slice(0, url.index);
      let value = token.slice(url.index);
      const end = value.search(/[?#]/);
      if (end !== -1) value = value.slice(0, end);
      const authorityEnd = value.indexOf('/', value.indexOf('://') + 3);
      const start = value.indexOf('://') + 3;
      const at = value.lastIndexOf('@', authorityEnd === -1 ? value.length : authorityEnd);
      if (at >= start) value = value.slice(0, start) + value.slice(at + 1);
      // Slashes in URLs delimit resources, not one giant base64 token.
      return prefix + value.replace(/[A-Za-z0-9_+-]+={0,2}/g, part => secretLike(part) ? '[token]' : part);
    }
    const path = PATH_AT.exec(token);
    const start = path ? path.index + (/^[('"=|]/.test(path[0]) ? 1 : 0) : 0;
    const prefix = token.slice(0, start);
    let value = token.slice(start);
    if (PATH_START.test(value) && /[^/\\]/.test(value)) {
      // A relative URL path (`/api/user?token=x#frag`) carries its secrets after ? or #.
      const skip = value.startsWith('\\\\?\\') ? 4 : 0; // the `?` of a \\?\ extended path is not a query
      const query = value.slice(skip).search(/[?#]/);
      if (query !== -1) value = value.slice(0, skip + query);
      return prefix + tokens(value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1).replace(/:\d+(?::\d+)?(?=[)\],;]*$)/, ''));
    }
    // `fetch?token=x` style words: cut a query only when it really has key=value pairs.
    const loose = /[?#][^\s=]*=/.exec(token);
    return tokens(loose ? token.slice(0, loose.index) : token);
  });
}

function redact(text, plan) {
  const values = [...new Set((plan.flows ?? []).flatMap(flow => flow.steps.filter(step => 'fill' in step && step.value).map(step => step.value)))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    text = text.split(/(\[redacted\]|\[token\])/).map(part => ['[redacted]', '[token]'].includes(part) ? part : part.split(value).join('[redacted]')).join('');
    // A producer or a rolling tail may already have cut a value at either edge.
    for (let length = value.length - 1; length >= 4; length--) {
      if (text.endsWith(value.slice(0, length))) { text = text.slice(0, -length) + '[redacted]'; break; }
    }
    for (let length = value.length - 1; length >= 4; length--) {
      if (text.startsWith(value.slice(-length))) { text = '[redacted]' + text.slice(length); break; }
    }
  }
  return text;
}
module.exports = { scrubForDisplay, redact };
