/**
 * A tiny, dependency-free .xlsx writer: one or more sheets of text and numbers, stored in an uncompressed ZIP.
 * Enough for report exports that open cleanly in Excel, Google Sheets and LibreOffice.
 */
export type Cell = string | number | null | undefined
export type Sheet = { name: string; rows: Cell[][] }

const enc = new TextEncoder()
/** XML-safe text: escapes markup and drops control characters that XML 1.0 forbids. */
const xml = (s: string) => Array.from(s).filter((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || c === 13 || c >= 32 }).join('').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

let table: Uint32Array | null = null
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function colName(i: number): string { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }

function sheetXml(rows: Cell[][]): string {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    if (v == null || v === '') return ''
    const ref = `${colName(ci)}${ri + 1}`
    return typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`
  }).join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0
  const u16 = (v: number) => [v & 255, (v >>> 8) & 255]
  const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data)
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...name])
    parts.push(local, f.data)
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]))
    offset += local.length + f.data.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)])
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0)); let o = 0
  for (const p of all) { out.set(p, o); o += p.length }
  return out
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const names = sheets.map((s, i) => xml(s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`))
  const files = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) })),
  ]
  return zip(files.map((f) => ({ name: f.name, data: enc.encode(f.text) })))
}

export function downloadXlsx(filename: string, sheets: Sheet[]) {
  const url = URL.createObjectURL(new Blob([buildXlsx(sheets) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
}
