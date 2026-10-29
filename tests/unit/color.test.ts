import { describe, expect, it } from 'vitest'
import { brandCss, hexToHsl, readableOn } from '../../src/lib/color'

describe('brand colour', () => {
  it('converts hex to hsl', () => {
    expect(hexToHsl('#ff0000')).toEqual({ h: 0, s: 100, l: 50 })
    expect(hexToHsl('#0f766e')).toEqual({ h: 175, s: 77, l: 26 })
    expect(hexToHsl('#ffffff')).toEqual({ h: 0, s: 0, l: 100 })
    expect(hexToHsl('red')).toBeNull()
    expect(hexToHsl('#12345')).toBeNull()
  })
  it('chooses readable text', () => {
    expect(readableOn('#0f766e')).toBe('white')
    expect(readableOn('#fde047')).toBe('black')
    expect(readableOn('#000000')).toBe('white')
  })
  it('emits light and dark overrides, and nothing for invalid input', () => {
    const css = brandCss('#0f766e')
    expect(css).toContain('--brand:175 77% 26%')
    expect(css).toContain("[data-theme='dark']")
    expect(brandCss('nope')).toBe('')
  })
  it('lightens very dark brands in dark mode', () => {
    expect(brandCss('#000000')).toContain("--brand:0 0% 52%")
  })
})
