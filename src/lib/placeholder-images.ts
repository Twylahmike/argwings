/**
 * Apartment photos (supplied by the owner; folder still guarded by `npm run check:placeholders` until the owner
 * confirms the guard can go). This is the ONLY module that references that folder. A property's own photos
 * uploaded in Admin always come first; these fill in for properties that have none.
 *
 * To switch to other photos: replace the files in the folder and edit the list below. Nothing else changes.
 */
import livingRoom from '~/assets/placeholders-everlett/living-room.webp'
import bedroom from '~/assets/placeholders-everlett/bedroom.webp'
import masterBedroom from '~/assets/placeholders-everlett/master-bedroom.webp'
import kitchen from '~/assets/placeholders-everlett/kitchen.webp'
import balcony from '~/assets/placeholders-everlett/balcony.webp'
import balconyView from '~/assets/placeholders-everlett/balcony-view.webp'
import terrace from '~/assets/placeholders-everlett/terrace.webp'
import dining from '~/assets/placeholders-everlett/dining-area.webp'
import gym from '~/assets/placeholders-everlett/gym.webp'
import pool from '~/assets/placeholders-everlett/pool.webp'
import laundry from '~/assets/placeholders-everlett/laundry.webp'
import rooftopDay from '~/assets/placeholders-everlett/rooftop-day.webp'
import rooftopEvening from '~/assets/placeholders-everlett/rooftop-evening.webp'
import bathroom from '~/assets/placeholders-everlett/bathroom.webp'
import studioBedroom from '~/assets/placeholders-everlett/studio-bedroom.webp'
import studioSofa from '~/assets/placeholders-everlett/studio-sofa.webp'
import studioKitchen from '~/assets/placeholders-everlett/studio-kitchen.webp'
import studioTv from '~/assets/placeholders-everlett/studio-tv-area.webp'

export type PlaceholderPhoto = { src: string; alt: string; label: string; category: string }
const P = (src: string, label: string, category: string, alt = label): PlaceholderPhoto => ({ src, alt, label, category })

const balconyP = P(balcony, 'Balcony', 'Balcony', 'Balcony seating')
const bedroomP = P(bedroom, 'Bedroom', 'Bedroom')
const gymP = P(gym, 'Gym', 'Amenities')
const kitchenP = P(kitchen, 'Kitchen', 'Amenities')
const livingP = P(livingRoom, 'Living area', 'Living')
const masterP = P(masterBedroom, 'Master bedroom', 'Bedroom')
const balconyViewP = P(balconyView, 'Balcony view', 'Balcony')
const poolP = P(pool, 'Pool', 'Pool', 'Indoor swimming pool')
const diningP = P(dining, 'Dining area', 'Living')
const terraceP = P(terrace, 'Terrace', 'Balcony')
const laundryP = P(laundry, 'Laundry', 'Amenities')
const roofDayP = P(rooftopDay, 'Rooftop', 'Exterior')
const roofEveP = P(rooftopEvening, 'Rooftop at dusk', 'Exterior')
const bathP = P(bathroom, 'Bathroom', 'Studio')
const sBedP = P(studioBedroom, 'Studio bedroom', 'Studio')
const sSofaP = P(studioSofa, 'Studio lounge', 'Studio')
const sKitP = P(studioKitchen, 'Studio kitchen', 'Studio')
const sTvP = P(studioTv, 'Studio TV area', 'Studio')

/** Everything, in the order the hero and gallery use. */
export const PLACEHOLDER_PHOTOS: PlaceholderPhoto[] = [
  balconyP, bedroomP, gymP, kitchenP, livingP, masterP, balconyViewP, poolP,
  diningP, terraceP, laundryP, roofDayP, roofEveP, sSofaP, sKitP, sBedP, sTvP, bathP,
]

/** Which photos belong to which apartment (by property slug). */
const BY_SLUG: Record<string, PlaceholderPhoto[]> = {
  'lavington-1-bedroom': [poolP, livingP, bedroomP, balconyP, masterP, kitchenP, balconyViewP, terraceP, diningP, laundryP, gymP],
  'fedha-studio': [sKitP, sSofaP, sTvP, sBedP, bathP],
}

/** Placeholder number `i` (wraps around), or null when there are none. */
export function placeholderAt(i: number): PlaceholderPhoto | null {
  const n = PLACEHOLDER_PHOTOS.length
  return n ? PLACEHOLDER_PHOTOS[((i % n) + n) % n] : null
}

/** Photos for a property that has none of its own: its own set if we know the slug, otherwise a rotating few. */
export function placeholderSet(slot: number, count = 4, slug?: string): PlaceholderPhoto[] {
  if (slug && BY_SLUG[slug]) return BY_SLUG[slug]
  const n = PLACEHOLDER_PHOTOS.length
  return n ? Array.from({ length: Math.min(count, n) }, (_, k) => PLACEHOLDER_PHOTOS[(slot * count + k) % n]) : []
}

export function photoByLabel(label: string): string | null {
  return PLACEHOLDER_PHOTOS.find((p) => p.label === label)?.src ?? null
}

/** The property's own cover image if it has one, otherwise its first stand-in. Null when neither exists. */
export function coverOrPlaceholder(cover: string | null | undefined, i: number, slug?: string): { src: string; alt?: string; placeholder: boolean } | null {
  if (cover) return { src: cover, placeholder: false }
  const p = (slug && BY_SLUG[slug]?.[0]) || placeholderAt(i)
  return p ? { src: p.src, alt: p.alt, placeholder: true } : null
}
