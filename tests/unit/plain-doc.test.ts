import { describe, expect, it } from 'vitest'
import { parseDoc, slugifyPage } from '../../src/lib/plain-doc'

describe('plain document syntax', () => {
  it('builds headings, paragraphs and lists, joining wrapped lines', () => {
    expect(parseDoc('# Title\nFirst line\nsecond line\n\n- a\n- b\n\nEnd')).toEqual([
      { type: 'h', text: 'Title' }, { type: 'p', text: 'First line second line' }, { type: 'ul', items: ['a', 'b'] }, { type: 'p', text: 'End' },
    ])
  })
  it('keeps markup as plain text (never interpreted)', () => {
    expect(parseDoc('<script>alert(1)</script>')).toEqual([{ type: 'p', text: '<script>alert(1)</script>' }])
  })
  it('makes safe slugs', () => { expect(slugifyPage(' House Rules & Quiet Hours! ')).toBe('house-rules-quiet-hours') })
})
