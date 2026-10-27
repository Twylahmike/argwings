import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/book')({
  validateSearch: (s: Record<string, unknown>): { unit: string; in: string; out: string; guests: number } => ({
    unit: String(s.unit ?? ''), in: String(s.in ?? ''), out: String(s.out ?? ''), guests: Math.max(1, Number(s.guests) || 1),
  }),
  component: () => <main className="p-8">Checkout</main>,
})
