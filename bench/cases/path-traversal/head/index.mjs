import path from 'node:path';
export function serve(root, name, read) {
  return read(path.join(root, name));
}
