// Amounts are decimal strings; sum them in integer cents.
export function addCents(a, b) {
  const cents = Math.round(Number(a) * 100) + Math.round(Number(b) * 100);
  return (cents / 100).toFixed(2);
}
