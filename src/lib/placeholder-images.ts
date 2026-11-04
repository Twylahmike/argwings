/**
 * TEMPORARY stand-in photos (owned by another client, dev branch only). See src/assets/placeholders-everlett/README.md.
 * This is the ONLY module allowed to reference that folder. Real photos (property cover_image / gallery) always win;
 * these appear only when a property has none.
 *
 * To switch to RG Wings' own photos: delete the folder and replace PLACEHOLDER_PHOTOS with `[]` (or your own files).
 * Nothing else in the app needs to change.
 */
import livingRoom from '~/assets/placeholders-everlett/living-room.webp'
import bedroom from '~/assets/placeholders-everlett/bedroom.webp'
import masterBedroom from '~/assets/placeholders-everlett/master-bedroom.webp'
import kitchen from '~/assets/placeholders-everlett/kitchen.webp'
import balcony from '~/assets/placeholders-everlett/balcony.webp'
import balconyView from '~/assets/placeholders-everlett/balcony-view.webp'
import gym from '~/assets/placeholders-everlett/gym.webp'
import pool from '~/assets/placeholders-everlett/pool.webp'
import laundry from '~/assets/placeholders-everlett/laundry.webp'

export type PlaceholderPhoto = { src: string; alt: string; label: string }

export const PLACEHOLDER_PHOTOS: PlaceholderPhoto[] = [
  { src: livingRoom, alt: 'Apartment living room', label: 'Living room' },
  { src: bedroom, alt: 'Apartment bedroom', label: 'Bedroom' },
  { src: balcony, alt: 'Apartment balcony seating', label: 'Balcony' },
  { src: kitchen, alt: 'Apartment kitchen', label: 'Kitchen' },
  { src: masterBedroom, alt: 'Apartment main bedroom', label: 'Main bedroom' },
  { src: pool, alt: 'Indoor swimming pool', label: 'Pool' },
  { src: balconyView, alt: 'View from the apartment balcony', label: 'Balcony view' },
  { src: gym, alt: 'Residents gym', label: 'Gym' },
  { src: laundry, alt: 'Laundry corner', label: 'Laundry' },
]

/** Placeholder number `i` (wraps around), or null when there are none. */
export function placeholderAt(i: number): PlaceholderPhoto | null {
  const n = PLACEHOLDER_PHOTOS.length
  return n ? PLACEHOLDER_PHOTOS[((i % n) + n) % n] : null
}

/** The property's own cover image if it has one, otherwise a stable placeholder for slot `i`. Null when neither exists. */
export function coverOrPlaceholder(cover: string | null | undefined, i: number): { src: string; alt?: string; placeholder: boolean } | null {
  if (cover) return { src: cover, placeholder: false }
  const p = placeholderAt(i)
  return p ? { src: p.src, alt: p.alt, placeholder: true } : null
}
