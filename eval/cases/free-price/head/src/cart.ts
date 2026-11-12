import { formatPrice } from "./format";

export function cartTotalLabel(items: { price: number }[]): string {
  const total = items.reduce((sum, i) => sum + i.price, 0);
  return `합계 ${formatPrice(total)}`;
}
