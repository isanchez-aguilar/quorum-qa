import { addCents } from './money.mjs';

// One row per abono, newest first.
export function payments(debts) {
  const rows = [];
  for (const debt of debts) {
    for (const p of debt.payments) rows.push({ key: p.id, amount: p.amount, method: p.method, paidAt: p.paidAt, parts: [{ concept: debt.concept, amount: p.amount }] });
  }
  return rows.sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt));
}
