/** Tiny colour helpers for the brand colour setting. Brand tokens are stored as "H S% L%" triplets (see styles/theme.css). */
export const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  if (!HEX_RE.test(hex)) return null
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return { h: Math.round(((h * 60) + 360) % 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/** WCAG relative luminance of a hex colour. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Text colour (white or near-black) with the better contrast on the given background. */
export function readableOn(hex: string): 'white' | 'black' {
  const L = luminance(hex)
  return (1.05) / (L + 0.05) >= (L + 0.05) / 0.05 ? 'white' : 'black'
}

/** CSS that re-skins the whole app from one hex colour. Dark theme gets a lightened variant so it stays readable. */
export function brandCss(hex: string): string {
  const hsl = hexToHsl(hex)
  if (!hsl) return ''
  const fg = readableOn(hex) === 'white' ? '0 0% 100%' : '200 20% 8%'
  const dark = { ...hsl, l: Math.max(hsl.l, 52), s: Math.min(hsl.s, 70) }
  const darkFg = dark.l > 55 ? '200 20% 8%' : '0 0% 100%'
  return `:root{--brand:${hsl.h} ${hsl.s}% ${hsl.l}%;--brand-foreground:${fg};--ring:${hsl.h} ${hsl.s}% ${Math.min(hsl.l + 6, 60)}%}` +
    `:root[data-theme='dark']{--brand:${dark.h} ${dark.s}% ${dark.l}%;--brand-foreground:${darkFg};--ring:${dark.h} ${dark.s}% ${Math.min(dark.l + 6, 70)}%}`
}
