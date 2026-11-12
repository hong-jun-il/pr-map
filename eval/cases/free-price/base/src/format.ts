export function formatPrice(won: number): string {
  return `${won.toLocaleString("ko-KR")}원`;
}

export function formatLegacy(won: number): string {
  return `KRW ${won}`;
}
