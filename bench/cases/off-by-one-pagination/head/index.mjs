export function page(items, number, size) {
  const start = (number - 1) * size;
  const end = start + size;
  return { items: items.slice(start, end - 1), total: items.length };
}
