import { describe, expect, it } from 'vitest'
import { parseHeadline, safeUrl } from '../../src/lib/site-content'

describe('parseHeadline', () => {
  it('marks the *accent* word', () => {
    expect(parseHeadline('Book direct. Stay *well*.')).toEqual([
      { text: 'Book direct. Stay ', accent: false }, { text: 'well', accent: true }, { text: '.', accent: false },
    ])
  })
  it('handles plain text', () => { expect(parseHeadline('Hello')).toEqual([{ text: 'Hello', accent: false }]) })
})

describe('safeUrl', () => {
  it('allows https only', () => {
    expect(safeUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeUrl('http://example.com')).toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('')).toBeNull()
  })
})
