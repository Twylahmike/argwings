import type { PropertyWithUnits } from '~/lib/public-api'
import { STAY_PHOTOS } from '~/lib/stay-photos'

export type GalleryItem = { src: string; alt: string; caption: string; group: string }

/** Every real photo a property has (cover, gallery, unit images), de-duplicated. */
export function propertyImages(p: PropertyWithUnits): string[] {
  return [...new Set([p.cover_image, ...(p.gallery ?? []), ...p.units.flatMap((u) => u.images ?? [])].filter((u): u is string => !!u))]
}

/** Real property photos. Only when there are none at all do the temporary placeholders step in. */
export function galleryItems(properties: PropertyWithUnits[]): GalleryItem[] {
  const real: GalleryItem[] = properties.flatMap((p) =>
    propertyImages(p).map((src, i) => ({ src, alt: `${p.name} photo ${i + 1}`, caption: p.name, group: p.name })))
  if (real.length) return real
  return STAY_PHOTOS.map((p) => ({ src: p.src, alt: p.alt, caption: p.label, group: p.category }))
}

/** Hero slides: real photos first, placeholders only when there are none. */
export function heroSlides(properties: PropertyWithUnits[], max = 8): { src: string; alt: string }[] {
  return galleryItems(properties).slice(0, max).map(({ src, alt }) => ({ src, alt }))
}
