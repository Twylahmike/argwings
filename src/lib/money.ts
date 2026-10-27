/** All money is integer KES. Never store or compute with decimals. */
export function formatKES(amount: number | null | undefined): string {
  const n = Math.round(Number(amount ?? 0))
  return `KES ${n.toLocaleString('en-US')}`
}

/** Parses user input like "12,500" or "KES 12500" to an integer, or null if invalid. */
export function parseKES(input: string): number | null {
  const cleaned = input.replace(/kes/gi, '').replace(/[,\s]/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  return Number(cleaned)
}

/** Balance still owed. Never negative. */
export function balanceOf(total: number, paid: number): number {
  return Math.max(0, total - paid)
}
