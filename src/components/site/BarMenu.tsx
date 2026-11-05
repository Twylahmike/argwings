import { useBrand } from '~/lib/brand'
import { formatKES } from '~/lib/money'

/** Drinks and snacks menu. Renders nothing unless the owner switched the bar menu on and added items. */
export function BarMenu() {
  const { barMenu } = useBrand()
  if (!barMenu.length) return null
  return (
    <section id="menu" aria-labelledby="menu-h" className="bg-background px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <h2 id="menu-h" className="section-title mb-10 text-center">Bar menu</h2>
        <div className="grid gap-10 md:grid-cols-2">
          {barMenu.map((s) => (
            <div key={s.name}>
              <h3 className="mb-4 border-b pb-2 font-display text-2xl">{s.name}</h3>
              <ul className="space-y-4">
                {s.items.map((i) => (
                  <li key={i.id} className="flex gap-3">
                    {i.image && <img src={i.image} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-lg object-cover" />}
                    <div className="min-w-0 flex-1"><p className="flex justify-between gap-3 font-medium"><span>{i.name}</span><span className="tabular-nums">{formatKES(i.price)}</span></p>{i.description && <p className="text-sm text-muted-foreground">{i.description}</p>}</div>
                  </li>))}
              </ul>
            </div>))}
        </div>
      </div>
    </section>
  )
}
