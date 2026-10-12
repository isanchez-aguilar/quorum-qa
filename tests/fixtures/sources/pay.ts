// Synthetic fixture for the verifier tests. Not part of the product.
const TAX_RATIO = 0.16;

export interface Line {
  price: number;
  quantity: number;
}

export function subtotal(lines: Line[]): number {
  let total = 0;
  for (const line of lines) {
    total += line.price * line.quantity;
  }
  return total;
}

export function withTax(price: number): number {
  let total = price * (1 + TAX_RATIO);
  return Math.round(total * 100) / 100;
}
