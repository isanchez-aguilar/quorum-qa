// The abonos a plan lets the owner see: the free plan keeps only the last 90
// days, a paid plan keeps everything. A debt's paidAmount always counts them all.
export function visibleAbonos(abonos, plan, now = Date.now()) {
  if (plan !== 'free') return abonos;
  const since = now - 90 * 24 * 60 * 60 * 1000;
  return abonos.filter(a => Date.parse(a.paidAt) >= since);
}
