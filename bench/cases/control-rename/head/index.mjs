function sumAmounts(amounts) {
  return amounts.reduce((sum, n) => sum + n, 0);
}
export const invoiceTotal = sumAmounts;
