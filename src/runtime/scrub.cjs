'use strict';

// Each pass scans disjoint tokens. No unanchored nested quantifiers on page text.
function scrubForDisplay(text) {
  const tokens = value => value.replace(/[A-Za-z0-9_+\/-]+={0,2}/g, token => token.length >= 24 ? '[token]' : token);
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
      return prefix + value.replace(/[A-Za-z0-9_+-]+={0,2}/g, part => part.length >= 24 ? '[token]' : part);
    }
    const path = /(?:^|[('"=|])(?:[A-Za-z]:[\\/]|\/)/.exec(token);
    const start = path ? path.index + (/^[('"=|]/.test(path[0]) ? 1 : 0) : 0;
    const prefix = token.slice(0, start);
    const value = token.slice(start);
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value) && /[^/\\]/.test(value)) {
      return prefix + tokens(value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1).replace(/:\d+(?::\d+)?(?=[)\],;]*$)/, ''));
    }
    return tokens(token);
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
