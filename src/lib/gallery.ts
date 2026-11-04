import type { PropertyWithUnits } from '~/lib/public-api'
import { PLACEHOLDER_PHOTOS } from '~/lib/placeholder-images'

export type GalleryItem = { src: string; alt: string; caption: string; group: string }

/** Real property photos (cover + gallery). Only when there are none at all do the temporary placeholders step in. */
export function galleryItems(properties: PropertyWithUnits[]): GalleryItem[] {
  const real: GalleryItem[] = properties.flatMap((p) => {
    const urls = [...new Set([p.cover_image, ...(p.gallery ?? [])].filter((u): u is string => !!u))]
    return urls.map((src, i) => ({ src, alt: `${p.name} photo ${i + 1}`, caption: p.name, group: p.name }))
  })
  if (real.length) return real
  return PLACEHOLDER_PHOTOS.map((p) => ({ src: p.src, alt: p.alt, caption: p.label, group: 'All' }))
}

/** Hero slides: real photos first, placeholders only when there are none. */
export function heroSlides(properties: PropertyWithUnits[], max = 6): { src: string; alt: string }[] {
  return galleryItems(properties).slice(0, max).map(({ src, alt }) => ({ src, alt }))
}
