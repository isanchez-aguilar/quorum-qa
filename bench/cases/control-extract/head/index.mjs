function label(name) {
  return name.trim();
}
export function greeting(name) {
  return 'Hello, ' + label(name) + '!';
}
