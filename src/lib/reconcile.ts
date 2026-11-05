/** Matching a bank or M-Pesa statement (CSV) against recorded payments. Pure functions so the rules can be tested. */
export type StatementRow = { ref: string; amount: number; date: string; line: number }
export type PaymentRef = { id: string; reference: string; method: string; kind: string; amount: number; mpesa_receipt: string | null; verified: boolean; confirmed_at: string }
export type Match =
  | { status: 'matched'; row: StatementRow; payment: PaymentRef }
  | { status: 'amount_mismatch'; row: StatementRow; payment: PaymentRef }
  | { status: 'possible'; row: StatementRow; payment: PaymentRef }
  | { status: 'missing_in_system'; row: StatementRow }
  | { status: 'not_on_statement'; payment: PaymentRef }

/** Minimal CSV reader: quoted fields, commas inside quotes, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim())) rows.push(row); row = [] }
    else cell += ch
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
export const normRef = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '')
export function parseAmount(s: string): number | null {
  const t = s.replace(/kes|ksh|\s|,/gi, '').replace(/^\((.*)\)$/, '-$1')
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  return Math.round(Number(t))
}

/** Finds the reference, amount and date columns by their headers and returns the credit rows (money in). */
export function parseStatement(text: string): { rows: StatementRow[]; error?: string } {
  const all = parseCsv(text)
  if (all.length < 2) return { rows: [], error: 'The file has no data rows.' }
  const head = all[0].map(clean)
  const find = (names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)))
  const iRef = find(['receiptno', 'receipt', 'transactionid', 'reference', 'ref', 'code', 'details'])
  const iAmt = find(['paidin', 'credit', 'amount'])
  const iDate = find(['completiontime', 'date', 'time'])
  if (iRef < 0 || iAmt < 0) return { rows: [], error: 'Could not find a reference/receipt column and an amount column in the first row.' }
  const rows: StatementRow[] = []
  all.slice(1).forEach((r, i) => {
    const amount = parseAmount(r[iAmt] ?? '')
    const ref = normRef(r[iRef] ?? '')
    if (amount == null || amount <= 0 || !ref) return
    rows.push({ ref, amount, date: (r[iDate] ?? '').trim().slice(0, 10), line: i + 2 })
  })
  return { rows }
}

export function matchStatement(rows: StatementRow[], payments: PaymentRef[]): Match[] {
  const out: Match[] = []
  const used = new Set<string>()
  const live = payments.filter((p) => p.kind !== 'refund')
  const byReceipt = new Map(live.filter((p) => p.mpesa_receipt).map((p) => [normRef(p.mpesa_receipt!), p]))
  for (const row of rows) {
    const p = byReceipt.get(row.ref)
    if (p && !used.has(p.id)) { used.add(p.id); out.push({ status: p.amount === row.amount ? 'matched' : 'amount_mismatch', row, payment: p }); continue }
    const near = live.filter((x) => !used.has(x.id) && !x.verified && x.amount === row.amount && (!row.date || Math.abs(Date.parse(x.confirmed_at.slice(0, 10)) - Date.parse(row.date)) <= 3 * 86_400_000))
    if (near.length === 1) { used.add(near[0].id); out.push({ status: 'possible', row, payment: near[0] }); continue }
    out.push({ status: 'missing_in_system', row })
  }
  for (const p of live) if (!used.has(p.id) && !p.verified && p.method !== 'cash') out.push({ status: 'not_on_statement', payment: p })
  return out
}
