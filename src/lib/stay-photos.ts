/**
 * Apartment photos (supplied by the owner). This is the ONLY module that references src/assets/stays. A property's own photos
 * uploaded in Admin always come first; these fill in for properties that have none.
 *
 * To switch to other photos: replace the files in the folder and edit the list below. Nothing else changes.
 */
import livingRoom from '~/assets/stays/living-room.webp'
import bedroom from '~/assets/stays/bedroom.webp'
import masterBedroom from '~/assets/stays/master-bedroom.webp'
import kitchen from '~/assets/stays/kitchen.webp'
import balcony from '~/assets/stays/balcony.webp'
import balconyView from '~/assets/stays/balcony-view.webp'
import terrace from '~/assets/stays/terrace.webp'
import dining from '~/assets/stays/dining-area.webp'
import gym from '~/assets/stays/gym.webp'
import pool from '~/assets/stays/pool.webp'
import laundry from '~/assets/stays/laundry.webp'
import rooftopDay from '~/assets/stays/rooftop-day.webp'
import rooftopEvening from '~/assets/stays/rooftop-evening.webp'
import bathroom from '~/assets/stays/bathroom.webp'
import studioBedroom from '~/assets/stays/studio-bedroom.webp'
import studioSofa from '~/assets/stays/studio-sofa.webp'
import studioKitchen from '~/assets/stays/studio-kitchen.webp'
import studioTv from '~/assets/stays/studio-tv-area.webp'

export type StayPhoto = { src: string; alt: string; label: string; category: string }
const P = (src: string, label: string, category: string, alt = label): StayPhoto => ({ src, alt, label, category })

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
export const STAY_PHOTOS: StayPhoto[] = [
  balconyP, bedroomP, gymP, kitchenP, livingP, masterP, balconyViewP, poolP,
  diningP, terraceP, laundryP, roofDayP, roofEveP, sSofaP, sKitP, sBedP, sTvP, bathP,
]

/** Which photos belong to which apartment (by property slug). */
const BY_SLUG: Record<string, StayPhoto[]> = {
  'lavington-1-bedroom': [poolP, livingP, bedroomP, balconyP, masterP, kitchenP, balconyViewP, terraceP, diningP, laundryP, gymP],
  'fedha-studio': [sKitP, sSofaP, sTvP, sBedP, bathP],
}

/** Placeholder number `i` (wraps around), or null when there are none. */
export function photoAt(i: number): StayPhoto | null {
  const n = STAY_PHOTOS.length
  return n ? STAY_PHOTOS[((i % n) + n) % n] : null
}

/** Photos for a property that has none of its own: its own set if we know the slug, otherwise a rotating few. */
export function photoSet(slot: number, count = 4, slug?: string): StayPhoto[] {
  if (slug && BY_SLUG[slug]) return BY_SLUG[slug]
  const n = STAY_PHOTOS.length
  return n ? Array.from({ length: Math.min(count, n) }, (_, k) => STAY_PHOTOS[(slot * count + k) % n]) : []
}

export function photoByLabel(label: string): string | null {
  return STAY_PHOTOS.find((p) => p.label === label)?.src ?? null
}

/** The property's own cover image if it has one, otherwise its first stand-in. Null when neither exists. */
export function coverOrFallback(cover: string | null | undefined, i: number, slug?: string): { src: string; alt?: string; placeholder: boolean } | null {
  if (cover) return { src: cover, placeholder: false }
  const p = (slug && BY_SLUG[slug]?.[0]) || photoAt(i)
  return p ? { src: p.src, alt: p.alt, placeholder: true } : null
}
