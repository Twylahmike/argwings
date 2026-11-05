// Member emails (welcome, offer ready, birthday, member promotion). Plain TS so Vitest can import it.
import { formatDate, formatKES } from './format.ts'

export type MemberEmailKind = 'welcome' | 'welcome_offer' | 'birthday' | 'promotion'

export type MemberContext = {
  business: string
  name: string
  site: string                 // https://example.com (no trailing slash)
  contactPhone?: string | null
  contactEmail?: string | null
  address?: string | null
  offer?: { name: string; description?: string | null; terms?: string | null; kind: 'percent' | 'fixed'; value: number; maxDiscount?: number | null; minTotal?: number; code?: string | null; expiresAt?: string | null }
}

const first = (n: string) => (n || 'there').trim().split(/\s+/)[0]

export function describeValue(o: NonNullable<MemberContext['offer']>): string {
  const base = o.kind === 'percent' ? `${o.value}% off` : `${formatKES(o.value)} off`
  return o.maxDiscount ? `${base} (up to ${formatKES(o.maxDiscount)})` : base
}

export function renderMemberEmail(kind: MemberEmailKind, c: MemberContext): { subject: string; text: string; cta?: { label: string; url: string } } {
  const hi = `Hi ${first(c.name)},`
  const o = c.offer
  const offerLines = o ? [
    `${o.name}: ${describeValue(o)} on your room charge${o.minTotal ? ` (stays from ${formatKES(o.minTotal)})` : ''}.`,
    o.code ? `Your code: ${o.code}. You do not need to type it: it is applied for you when you book while signed in.` : '',
    o.expiresAt ? `Use it by ${formatDate(o.expiresAt.slice(0, 10))}.` : '',
    o.terms ? `Terms: ${o.terms}` : '',
  ].filter(Boolean) : []
  const contact = [c.contactPhone ? `Call or WhatsApp ${c.contactPhone}` : '', c.contactEmail ? `Email ${c.contactEmail}` : '', c.address ?? ''].filter(Boolean)
  const footer = ['', `— ${c.business}`, ...contact]
  switch (kind) {
    case 'welcome':
      return {
        subject: `Welcome to ${c.business}`,
        text: [hi, `Welcome to ${c.business}. Your free membership is now active.`, 'Sign in any time to see your bookings, receipts, offers and rewards in one place.', ...footer].join('\n'),
        cta: { label: 'Open my account', url: `${c.site}/account` },
      }
    case 'welcome_offer':
      return {
        subject: 'Your welcome offer is ready',
        text: [hi, 'Your welcome offer is ready.', ...offerLines, ...footer].join('\n'),
        cta: { label: 'Find a place to stay', url: `${c.site}/search` },
      }
    case 'birthday':
      return {
        subject: `A birthday treat from ${c.business}`,
        text: [hi, `Happy birthday from all of us at ${c.business}.`, 'We have added a little something to your account:', ...offerLines, 'You can turn these emails off in Account settings.', ...footer].join('\n'),
        cta: { label: 'Plan a stay', url: `${c.site}/search` },
      }
    case 'promotion':
      return {
        subject: o ? `Member offer: ${o.name}` : `A member offer from ${c.business}`,
        text: [hi, 'A new offer for members:', ...offerLines, o?.description ?? '', 'You can turn these emails off in Account settings.', ...footer].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
        cta: { label: 'See my offers', url: `${c.site}/account/offers` },
      }
  }
}
