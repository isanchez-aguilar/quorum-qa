function total(values) {
  return values.reduce((sum, n) => sum + n, 0);
}
export const invoiceTotal = total;
