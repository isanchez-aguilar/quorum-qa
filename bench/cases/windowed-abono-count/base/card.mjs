// The line on a debt card.
export function debtLine(debt) {
  return `${debt.concept}: $${debt.paidAmount} de $${debt.totalAmount}`;
}
