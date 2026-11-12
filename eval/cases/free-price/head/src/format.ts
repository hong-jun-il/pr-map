export function formatPrice(won: number): string {
  if (won === 0) return "무료";
  return `${won.toLocaleString("ko-KR")}원`;
}
