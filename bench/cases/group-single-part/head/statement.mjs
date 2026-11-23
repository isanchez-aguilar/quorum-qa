import { addCents } from './money.mjs';

// One row per payment the customer made, newest first. A general payment the
// shop split over several debts shares a groupId: join its parts back into one
// row, flagged `general` so the page can say it was split.
export function payments(debts) {
  const byKey = new Map();
  for (const debt of debts) {
    for (const p of debt.payments) {
      const key = p.groupId ?? p.id;
      const found = byKey.get(key);
      if (found) {
        found.amount = addCents(found.amount, p.amount);
        found.parts.push({ concept: debt.concept, amount: p.amount });
        continue;
      }
      byKey.set(key, { key, amount: p.amount, method: p.method, paidAt: p.paidAt, general: Boolean(p.groupId), parts: [{ concept: debt.concept, amount: p.amount }] });
    }
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt));
}
