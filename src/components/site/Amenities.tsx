import { Bath, BedDouble, Car, CookingPot, Dumbbell, Flame, Shirt, ShieldCheck, Snowflake, Sparkles, Tv, Waves, Wifi, type LucideIcon } from 'lucide-react'
import type { PropertyWithUnits } from '~/lib/public-api'

const ICONS: Array<[RegExp, LucideIcon]> = [
  [/wi-?fi|internet/i, Wifi], [/kitchen|cook/i, CookingPot], [/park|garage/i, Car], [/secur|cctv|guard|gate/i, ShieldCheck],
  [/pool|swim/i, Waves], [/gym|fitness/i, Dumbbell], [/tv|netflix|stream/i, Tv], [/air|a\/c|\bac\b|cool/i, Snowflake],
  [/bath|shower|towel/i, Bath], [/bed|linen/i, BedDouble], [/laundry|wash/i, Shirt], [/heat|hot water|fire/i, Flame],
]
const iconFor = (label: string): LucideIcon => ICONS.find(([re]) => re.test(label))?.[1] ?? Sparkles

/** Union of what the properties and units actually list. Nothing is invented: no amenities, no section. */
export function Amenities({ properties }: { properties: PropertyWithUnits[] }) {
  const seen = new Map<string, string>()
  for (const p of properties) for (const a of [...(p.amenities ?? []), ...p.units.flatMap((u) => u.amenities ?? [])]) {
    const label = a.trim()
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label)
  }
  const items = [...seen.values()].slice(0, 10)
  if (!items.length) return null
  return (
    <section className="bg-olive px-4 py-24 text-white sm:px-6" aria-labelledby="amen-h">
      <div className="mx-auto max-w-7xl text-center">
        <p className="eyebrow mb-3 opacity-70">Amenities</p>
        <h2 id="amen-h" className="section-title mb-14">Everything you need.</h2>
        <ul className="grid grid-cols-2 gap-8 md:grid-cols-5">
          {items.map((label, i) => {
            const Icon = iconFor(label)
            return (
              <li key={label} className="animate-fade-up flex flex-col items-center gap-3" style={{ animationDelay: `${i * 0.06}s` }}>
                <span className="hover-lift grid h-16 w-16 place-items-center rounded-full border border-current/20 bg-white/10 backdrop-blur"><Icon className="h-7 w-7" aria-hidden /></span>
                <span className="text-sm opacity-90">{label}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
