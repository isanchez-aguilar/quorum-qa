import { visibleAbonos } from './history.mjs';

// The line on a debt card, then the abonos that paid it so the owner sees by
// how much and how each time.
export function debtLine(debt) {
  return `${debt.concept}: $${debt.paidAmount} de $${debt.totalAmount}`;
}

export function abonosSummary(debt, abonos, plan) {
  const listed = visibleAbonos(abonos.filter(a => a.debtId === debt.id), plan);
  const label = listed.length === 1 ? '1 abono' : `${listed.length} abonos`;
  return { title: `Abonado $${debt.paidAmount} · ${label}`, rows: listed };
}
