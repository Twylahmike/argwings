import { describe, expect, it } from 'vitest'
import { matchStatement, parseCsv, parseStatement, type PaymentRef } from '../../src/lib/reconcile'

const pay = (o: Partial<PaymentRef>): PaymentRef => ({ id: 'p', reference: 'BNB-1', method: 'mpesa_manual', kind: 'deposit', amount: 3000, mpesa_receipt: 'SHK4T7XYZ1', verified: false, confirmed_at: '2026-03-02T09:00:00Z', ...o })

describe('statement reconciliation', () => {
  it('reads quoted CSV with commas and finds the columns', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']])
    const r = parseStatement('Receipt No.,Completion Time,Details,Paid In,Withdrawn\nshk4t7xyz1,2026-03-02 09:00:00,Pay,"3,000.00",\nABC,2026-03-02,Out,,500\n')
    expect(r.rows).toEqual([{ ref: 'SHK4T7XYZ1', amount: 3000, date: '2026-03-02', line: 2 }])
  })
  it('explains an unreadable file', () => { expect(parseStatement('foo,bar\n1,2').error).toMatch(/reference/i) })
  it('matches by receipt and flags amount differences, unknown money and unlisted payments', () => {
    const rows = [
      { ref: 'SHK4T7XYZ1', amount: 3000, date: '2026-03-02', line: 2 },
      { ref: 'AAA111', amount: 1000, date: '2026-03-02', line: 3 },
      { ref: 'ZZZ999', amount: 777, date: '2026-03-02', line: 4 },
    ]
    const m = matchStatement(rows, [pay({}), pay({ id: 'q', mpesa_receipt: 'AAA111', amount: 1200 }), pay({ id: 'r', mpesa_receipt: 'NOPE', amount: 450, method: 'bank' }), pay({ id: 's', method: 'cash', mpesa_receipt: null, amount: 100 })])
    expect(m.map((x) => x.status)).toEqual(['matched', 'amount_mismatch', 'missing_in_system', 'not_on_statement'])
  })
  it('offers a possible match only when exactly one unverified payment fits amount and date', () => {
    const rows = [{ ref: 'NEWREF', amount: 3000, date: '2026-03-03', line: 2 }]
    expect(matchStatement(rows, [pay({ mpesa_receipt: null })])[0].status).toBe('possible')
    expect(matchStatement(rows, [pay({ mpesa_receipt: null }), pay({ id: 'x', mpesa_receipt: null })])[0].status).toBe('missing_in_system')
    expect(matchStatement(rows, [pay({ mpesa_receipt: null, verified: true })])[0].status).toBe('missing_in_system')
  })
  it('refunds are never matched to incoming money', () => {
    expect(matchStatement([{ ref: 'SHK4T7XYZ1', amount: 3000, date: '', line: 2 }], [pay({ kind: 'refund' })])[0].status).toBe('missing_in_system')
  })
})
