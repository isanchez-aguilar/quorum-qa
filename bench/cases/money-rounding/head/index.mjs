export function quote(price) {
  const cents = Math.floor(price * 100);
  return { price, cents };
}
