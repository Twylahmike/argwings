import { Link } from '@tanstack/react-router'
import { useBrand } from '~/lib/brand'

/** Promotional banners from Admin > Homepage images (scheduled ones appear only inside their dates). */
export function PromoStrip() {
  const { promoBanners } = useBrand()
  if (!promoBanners.length) return null
  return (
    <section aria-label="Offers" className="bg-background px-4 py-8 sm:px-6">
      <ul className="mx-auto grid max-w-7xl gap-4 md:grid-cols-2 lg:grid-cols-3">
        {promoBanners.map((b) => {
          const inner = (
            <>
              <img src={b.src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" />
              <span className="absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/30 to-transparent" aria-hidden />
              <span className="relative flex h-full min-h-48 flex-col justify-end p-5 text-white">
                {b.title && <span className="font-display text-2xl">{b.title}</span>}
                {b.subtitle && <span className="mt-1 text-sm text-white/85">{b.subtitle}</span>}
                {b.href && <span className="mt-3 inline-block text-sm font-medium underline underline-offset-4">{b.label || 'Learn more'}</span>}
              </span>
            </>
          )
          const cls = 'group relative block overflow-hidden rounded-2xl'
          return (
            <li key={b.id}>
              {b.href.startsWith('/') ? <Link to={b.href} className={cls}>{inner}</Link>
                : b.href ? <a href={b.href} target="_blank" rel="noreferrer" className={cls}>{inner}</a> : <div className={cls}>{inner}</div>}
            </li>)
        })}
      </ul>
    </section>
  )
}
