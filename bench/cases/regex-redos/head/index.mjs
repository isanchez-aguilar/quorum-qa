export function validLabel(value) {
  return /^([a-z]+)+(-[a-z]+)*$/.test(value);
}
