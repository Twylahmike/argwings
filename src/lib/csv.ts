/** RFC 4180-ish CSV. Values starting with = + - @ are prefixed with ' to stop spreadsheet formula injection. */
export function toCsv<T>(rows: T[], columns: { header: string; value: (row: T) => string | number | null | undefined }[]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\r\n')
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }) // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
