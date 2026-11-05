import { describe, expect, it } from 'vitest'
import { buildXlsx, crc32 } from '../../src/lib/xlsx'

/** Minimal reader for the stored ZIP our writer produces: checks every entry's CRC and returns the text. */
function readZip(buf: Uint8Array): Record<string, string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eocd = buf.length - 22
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50)
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true), nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLen))
    const lnLen = dv.getUint16(off + 26, true), leLen = dv.getUint16(off + 28, true)
    const data = buf.slice(off + 30 + lnLen + leLen, off + 30 + lnLen + leLen + size)
    expect(crc32(data)).toBe(crc)
    out[name] = new TextDecoder().decode(data)
    p += 46 + nameLen + extra + comment
  }
  return out
}

describe('xlsx writer', () => {
  it('crc32 matches the standard check value', () => { expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926) })
  it('writes a valid package with escaped text and numbers', () => {
    const files = readZip(buildXlsx([{ name: 'Revenue: 2026/Q1?', rows: [['Item', 'Amount (KES)'], ['A & <B>', 1500], ['Empty', null], ['Big', 1234567]] }, { name: 'Second', rows: [['x']] }]))
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'])
    expect(files['xl/workbook.xml']).toContain('name="Revenue  2026 Q1 "')
    expect(files['xl/worksheets/sheet1.xml']).toContain('A &amp; &lt;B&gt;')
    expect(files['xl/worksheets/sheet1.xml']).toContain('<c r="B2"><v>1500</v></c>')
    expect(files['xl/worksheets/sheet1.xml']).not.toContain('r="B3"')
  })
})
