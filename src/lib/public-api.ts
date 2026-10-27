import { sb } from './supabase'
import type { Property, Unit } from './types'

export type PropertyWithUnits = Property & { units: Unit[] }

/** All visible properties with their bookable units (anon-readable by RLS). */
export async function fetchProperties(): Promise<PropertyWithUnits[]> {
  const [p, u] = await Promise.all([
    sb().from('properties').select('*').eq('active', true).order('sort').order('name'),
    sb().from('units').select('*').eq('active', true).order('sort').order('base_rate'),
  ])
  if (p.error) throw p.error
  if (u.error) throw u.error
  return (p.data as Property[]).map((prop) => ({ ...prop, units: (u.data as Unit[]).filter((x) => x.property_id === prop.id) }))
}

export async function fetchPropertyBySlug(slug: string): Promise<PropertyWithUnits | null> {
  const { data: prop, error } = await sb().from('properties').select('*').eq('slug', slug).eq('active', true).maybeSingle()
  if (error) throw error
  if (!prop) return null
  const { data: units, error: e2 } = await sb().from('units').select('*').eq('property_id', prop.id).eq('active', true).order('sort').order('base_rate')
  if (e2) throw e2
  return { ...(prop as Property), units: units as Unit[] }
}

export type AvailableUnit = { unit_id: string; property_id: string; nights: number; total: number }

export async function fetchAvailability(checkIn: string, checkOut: string, guests: number, propertyId?: string): Promise<AvailableUnit[]> {
  const { data, error } = await sb().rpc('get_available_units', { p_in: checkIn, p_out: checkOut, p_guests: guests, p_property: propertyId ?? null })
  if (error) throw error
  return data as AvailableUnit[]
}

export type DateRange = { start_date: string; end_date: string }
/** Occupied [start, end) ranges for a unit. Dates only: no guest data is ever exposed. */
export async function fetchUnavailableDates(unitId: string): Promise<DateRange[]> {
  const { data, error } = await sb().rpc('get_unit_unavailable_dates', { p_unit: unitId })
  if (error) throw error
  return data as DateRange[]
}

export type ServerQuote = { nights: number; nightly_total: number; cleaning_fee: number; total: number; min_nights: number }
export async function fetchQuote(unitId: string, checkIn: string, checkOut: string): Promise<ServerQuote | null> {
  const { data, error } = await sb().rpc('quote_stay', { p_unit: unitId, p_in: checkIn, p_out: checkOut })
  if (error) throw error
  return (data as ServerQuote[])[0] ?? null
}

export function mapsLink(p: Pick<Property, 'lat' | 'lng' | 'address' | 'name' | 'city'>): string {
  const q = p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : encodeURIComponent([p.name, p.address, p.city].filter(Boolean).join(', '))
  return `https://www.google.com/maps/search/?api=1&query=${q}`
}
