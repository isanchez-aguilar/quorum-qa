export function page(items, number, size) {
  return items.slice((number - 1) * size, number * size);
}
