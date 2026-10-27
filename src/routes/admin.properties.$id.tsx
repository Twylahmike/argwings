import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import type { Property, RateOverrideRow, Unit } from '~/lib/types'
import { formatKES } from '~/lib/money'
import { formatDate, formatTime } from '~/lib/dates'
import { normalizePhone } from '~/lib/phone'
import { slugify } from '~/lib/slug'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { EmptyState, ErrorState, Skeleton, Tabs } from '~/components/ui/misc'
import { ImageManager } from '~/components/layout/ImageManager'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/properties/$id')({
  beforeLoad: ({ context, params }) => {
    requireRole(context.me, ['owner', 'manager'])
    if (params.id === 'new') requireRole(context.me, ['owner'])
  },
  component: PropertyPage,
})

const optionalNum = z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().nullable())
const propSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name'),
  slug: z.string().trim().min(2, 'Enter a web address').regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes only'),
  tagline: z.string().max(140).optional(),
  description: z.string().optional(),
  address: z.string().optional(),
  area: z.string().optional(),
  city: z.string().min(1, 'Enter a city'),
  lat: optionalNum,
  lng: optionalNum,
  contact_phone: z.string().optional(),
  whatsapp_number: z.string().optional(),
  check_in_time: z.string().min(4),
  check_out_time: z.string().min(4),
  house_rules: z.string().optional(),
  amenities: z.string().optional(),
  active: z.boolean(),
})
type PropValues = z.input<typeof propSchema>

function PropertyPage() {
  const { id } = Route.useParams()
  const isNew = id === 'new'
  const [tab, setTab] = useState<'details' | 'units' | 'photos'>('details')
  const q = useQuery({
    queryKey: ['admin-property', id],
    enabled: !isNew,
    queryFn: async () => {
      const { data, error } = await sb().from('properties').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      if (!data) throw new Error('Property not found, or you do not have access.')
      return data as Property
    },
  })
  return (
    <div>
      <Link to="/admin/properties" className="mb-3 inline-flex h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All properties</Link>
      <h1 className="mb-4 text-xl font-semibold md:text-2xl">{isNew ? 'New property' : q.data?.name ?? 'Property'}</h1>
      {!isNew && (
        <div className="mb-5">
          <Tabs label="Property sections" value={tab} onChange={setTab} tabs={[{ value: 'details', label: 'Details' }, { value: 'units', label: 'Units & rates' }, { value: 'photos', label: 'Photos' }]} />
        </div>
      )}
      {!isNew && q.isLoading && <Skeleton className="h-96" />}
      {!isNew && q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {(isNew || q.data) && tab === 'details' && <DetailsForm property={q.data} />}
      {q.data && tab === 'units' && <UnitsSection property={q.data} />}
      {q.data && tab === 'photos' && <PhotosSection property={q.data} />}
    </div>
  )
}

function DetailsForm({ property }: { property?: Property }) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { me } = useAdmin()
  const { register, handleSubmit, watch, setValue, setError, formState: { errors, isSubmitting, dirtyFields } } = useForm<PropValues>({
    resolver: zodResolver(propSchema),
    defaultValues: {
      name: property?.name ?? '', slug: property?.slug ?? '', tagline: property?.tagline ?? '', description: property?.description ?? '',
      address: property?.address ?? '', area: property?.area ?? '', city: property?.city ?? 'Nairobi',
      lat: property?.lat ?? undefined, lng: property?.lng ?? undefined,
      contact_phone: property?.contact_phone ?? '', whatsapp_number: property?.whatsapp_number ?? '',
      check_in_time: formatTime(property?.check_in_time) || '14:00', check_out_time: formatTime(property?.check_out_time) || '10:00',
      house_rules: property?.house_rules ?? '', amenities: (property?.amenities ?? []).join(', '), active: property?.active ?? true,
    },
  })
  const name = watch('name')
  useEffect(() => { if (!property && !dirtyFields.slug) setValue('slug', slugify(name ?? '')) }, [name, property, dirtyFields.slug, setValue])

  async function onSubmit(raw: PropValues) {
    const v = propSchema.parse(raw)
    const phones: Record<string, string | null> = {}
    for (const k of ['contact_phone', 'whatsapp_number'] as const) {
      const val = v[k]?.trim()
      if (!val) { phones[k] = null; continue }
      const r = normalizePhone(val)
      if (!r.ok) { setError(k, { message: r.error }); return }
      phones[k] = r.phone
    }
    const row = {
      name: v.name, slug: v.slug, tagline: v.tagline || null, description: v.description || null, address: v.address || null,
      area: v.area || null, city: v.city, lat: v.lat, lng: v.lng, ...phones,
      check_in_time: v.check_in_time, check_out_time: v.check_out_time, house_rules: v.house_rules || null,
      amenities: (v.amenities ?? '').split(',').map((s) => s.trim()).filter(Boolean), active: v.active,
    }
    const res = property
      ? await sb().from('properties').update(row).eq('id', property.id).select('id').single()
      : await sb().from('properties').insert({ ...row, sort: 100 }).select('id').single()
    if (res.error) {
      if (res.error.code === '23505') setError('slug', { message: 'That web address is already used. Try another.' })
      else toast.error(errMessage(res.error))
      return
    }
    toast.success('Saved')
    qc.invalidateQueries({ queryKey: ['admin-property'] })
    qc.invalidateQueries({ queryKey: ['admin-properties'] })
    qc.invalidateQueries({ queryKey: ['me'] })
    if (!property) nav({ to: '/admin/properties/$id', params: { id: res.data.id } })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid max-w-3xl gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Property name" htmlFor="p-name" error={errors.name?.message}><Input id="p-name" {...register('name')} /></Field>
        <Field label="Web address" htmlFor="p-slug" error={errors.slug?.message} hint="Used in the link, e.g. /properties/kilimani-nest"><Input id="p-slug" {...register('slug')} /></Field>
      </div>
      <Field label="Tagline" htmlFor="p-tag" error={errors.tagline?.message}><Input id="p-tag" {...register('tagline')} /></Field>
      <Field label="Description" htmlFor="p-desc"><Textarea id="p-desc" rows={5} {...register('description')} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Address" htmlFor="p-addr" className="sm:col-span-3"><Input id="p-addr" {...register('address')} /></Field>
        <Field label="Area" htmlFor="p-area"><Input id="p-area" {...register('area')} /></Field>
        <Field label="City" htmlFor="p-city" error={errors.city?.message}><Input id="p-city" {...register('city')} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Latitude" htmlFor="p-lat"><Input id="p-lat" inputMode="decimal" {...register('lat')} /></Field>
          <Field label="Longitude" htmlFor="p-lng"><Input id="p-lng" inputMode="decimal" {...register('lng')} /></Field>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact phone" htmlFor="p-phone" error={errors.contact_phone?.message}><Input id="p-phone" inputMode="tel" {...register('contact_phone')} /></Field>
        <Field label="WhatsApp number" htmlFor="p-wa" error={errors.whatsapp_number?.message} hint="Guests who tap 'Book on WhatsApp' message this number."><Input id="p-wa" inputMode="tel" {...register('whatsapp_number')} /></Field>
        <Field label="Check-in time" htmlFor="p-ci"><Input id="p-ci" type="time" {...register('check_in_time')} /></Field>
        <Field label="Check-out time" htmlFor="p-co"><Input id="p-co" type="time" {...register('check_out_time')} /></Field>
      </div>
      <Field label="House rules" htmlFor="p-rules" hint="One rule per line."><Textarea id="p-rules" rows={5} {...register('house_rules')} /></Field>
      <Field label="Amenities" htmlFor="p-amen" hint="Separate with commas, e.g. Fast WiFi, Hot shower, Parking"><Input id="p-amen" {...register('amenities')} /></Field>
      {isOwner(me) && (
        <label className="flex h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" {...register('active')} /> Visible on the booking site</label>
      )}
      <div><Button type="submit" loading={isSubmitting}>{property ? 'Save changes' : 'Create property'}</Button></div>
    </form>
  )
}

function PhotosSection({ property }: { property: Property }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: async (patch: Partial<Pick<Property, 'gallery' | 'cover_image'>>) => {
      const { error } = await sb().from('properties').update(patch).eq('id', property.id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-property', property.id] }),
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Card>
      <CardHeader><CardTitle>Property photos</CardTitle><p className="text-sm text-muted-foreground">Photos are compressed automatically. The starred photo is the cover. Drag order: use the arrows.</p></CardHeader>
      <CardContent>
        <ImageManager urls={property.gallery} cover={property.cover_image} folder={property.id}
          onChange={(gallery) => save.mutate({ gallery })} onCoverChange={(cover_image) => save.mutate({ cover_image })} />
      </CardContent>
    </Card>
  )
}

/* ---------------------------------- Units & rates ---------------------------------- */

function UnitsSection({ property }: { property: Property }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Unit | 'new' | null>(null)
  const units = useQuery({
    queryKey: ['admin-units', property.id],
    queryFn: async () => {
      const { data, error } = await sb().from('units').select('*').eq('property_id', property.id).order('sort').order('name')
      if (error) throw error
      return data as Unit[]
    },
  })
  return (
    <div>
      <div className="mb-3 flex justify-end"><Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Add unit</Button></div>
      {units.isLoading && <Skeleton className="h-40" />}
      {units.error && <ErrorState error={units.error} retry={() => units.refetch()} />}
      {units.data?.length === 0 && <EmptyState title="No units yet" description="Add a room, studio or house guests can book." action={<Button onClick={() => setEditing('new')}>Add the first unit</Button>} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {units.data?.map((u) => (
          <Card key={u.id}>
            <CardContent className="pt-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{u.name} {u.code && <span className="text-xs font-normal text-muted-foreground">({u.code})</span>}</p>
                  <p className="text-sm text-muted-foreground">{u.unit_type} · up to {u.max_guests} guests · min {u.min_nights} night{u.min_nights > 1 ? 's' : ''}</p>
                </div>
                {!u.active && <Badge className="text-muted-foreground">Inactive</Badge>}
              </div>
              <p className="mt-2 text-sm">{formatKES(u.base_rate)}{u.weekend_rate != null && <> · weekend {formatKES(u.weekend_rate)}</>} · cleaning {formatKES(u.cleaning_fee)}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing(u)}><Pencil className="h-4 w-4" /> Edit unit & rates</Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {editing && <UnitDialog property={property} unit={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['admin-units', property.id] }); qc.invalidateQueries({ queryKey: ['admin-properties'] }) }} />}
    </div>
  )
}

const num = (label: string, min = 0) => z.preprocess((v) => (v === '' || v == null ? NaN : Number(v)), z.number({ message: `${label} must be a number` }).int(`${label} must be a whole number`).min(min, `${label} must be at least ${min}`))
const unitSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name'),
  code: z.string().optional(),
  unit_type: z.string().min(1),
  description: z.string().optional(),
  max_guests: num('Guests', 1),
  bedrooms: num('Bedrooms', 0),
  beds: num('Beds', 1),
  base_rate: num('Nightly rate'),
  weekend_rate: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().min(0).nullable()),
  cleaning_fee: num('Cleaning fee'),
  min_nights: num('Minimum nights', 1),
  amenities: z.string().optional(),
  active: z.boolean(),
})
type UnitValues = z.input<typeof unitSchema>

function UnitDialog({ property, unit, onClose, onSaved }: { property: Property; unit?: Unit; onClose: () => void; onSaved: () => void }) {
  const [images, setImages] = useState<string[]>(unit?.images ?? [])
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<UnitValues>({
    resolver: zodResolver(unitSchema),
    defaultValues: {
      name: unit?.name ?? '', code: unit?.code ?? '', unit_type: unit?.unit_type ?? 'room', description: unit?.description ?? '',
      max_guests: unit?.max_guests ?? 2, bedrooms: unit?.bedrooms ?? 1, beds: unit?.beds ?? 1,
      base_rate: unit?.base_rate ?? 4000, weekend_rate: unit?.weekend_rate ?? undefined, cleaning_fee: unit?.cleaning_fee ?? 0,
      min_nights: unit?.min_nights ?? 1, amenities: (unit?.amenities ?? []).join(', '), active: unit?.active ?? true,
    },
  })
  async function onSubmit(raw: UnitValues) {
    const v = unitSchema.parse(raw)
    const row = { ...v, code: v.code || null, description: v.description || null, amenities: (v.amenities ?? '').split(',').map((s) => s.trim()).filter(Boolean), images, property_id: property.id }
    const res = unit ? await sb().from('units').update(row).eq('id', unit.id) : await sb().from('units').insert({ ...row, sort: 100 })
    if (res.error) { toast.error(errMessage(res.error)); return }
    toast.success('Unit saved')
    onSaved()
    onClose()
  }
  async function remove() {
    if (!unit) return
    const { count } = await sb().from('bookings').select('id', { count: 'exact', head: true }).eq('unit_id', unit.id)
    if ((count ?? 0) > 0) {
      if (!confirm('This unit has bookings, so it cannot be deleted. Hide it from the booking site instead?')) return
      const { error } = await sb().from('units').update({ active: false }).eq('id', unit.id)
      if (error) { toast.error(errMessage(error)); return }
      toast.success('Unit hidden')
    } else {
      if (!confirm('Delete this unit permanently?')) return
      const { error } = await sb().from('units').delete().eq('id', unit.id)
      if (error) { toast.error('Only the owner can delete units. You can hide it instead.'); return }
      toast.success('Unit deleted')
    }
    onSaved(); onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={unit ? `Edit ${unit.name}` : 'Add unit'} className="max-w-2xl">
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="u-name" error={errors.name?.message} className="sm:col-span-2"><Input id="u-name" {...register('name')} /></Field>
            <Field label="Code" htmlFor="u-code"><Input id="u-code" {...register('code')} /></Field>
            <Field label="Type" htmlFor="u-type"><Select id="u-type" {...register('unit_type')}>{['room', 'studio', '1BR', '2BR', 'house'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="Max guests" htmlFor="u-max" error={errors.max_guests?.message}><Input id="u-max" inputMode="numeric" {...register('max_guests')} /></Field>
            <Field label="Min nights" htmlFor="u-min" error={errors.min_nights?.message}><Input id="u-min" inputMode="numeric" {...register('min_nights')} /></Field>
            <Field label="Bedrooms" htmlFor="u-bed" error={errors.bedrooms?.message}><Input id="u-bed" inputMode="numeric" {...register('bedrooms')} /></Field>
            <Field label="Beds" htmlFor="u-beds" error={errors.beds?.message}><Input id="u-beds" inputMode="numeric" {...register('beds')} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Nightly rate (KES)" htmlFor="u-base" error={errors.base_rate?.message}><Input id="u-base" inputMode="numeric" {...register('base_rate')} /></Field>
            <Field label="Weekend rate (KES)" htmlFor="u-wk" hint="Fri and Sat nights. Leave empty to use the nightly rate." error={errors.weekend_rate?.message}><Input id="u-wk" inputMode="numeric" {...register('weekend_rate')} /></Field>
            <Field label="Cleaning fee (KES)" htmlFor="u-clean" hint="Charged once per stay." error={errors.cleaning_fee?.message}><Input id="u-clean" inputMode="numeric" {...register('cleaning_fee')} /></Field>
          </div>
          <Field label="Description" htmlFor="u-desc"><Textarea id="u-desc" rows={3} {...register('description')} /></Field>
          <Field label="Amenities" htmlFor="u-amen" hint="Separate with commas."><Input id="u-amen" {...register('amenities')} /></Field>
          <div><p className="mb-2 text-sm font-medium">Unit photos</p><ImageManager urls={images} onChange={setImages} folder={`${property.id}/units`} /></div>
          <label className="flex h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" {...register('active')} /> Available for booking</label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={isSubmitting}>Save unit</Button>
            {unit && <Button type="button" variant="outline" className="text-danger" onClick={remove}><Trash2 className="h-4 w-4" /> Delete</Button>}
          </div>
        </form>
        {unit && <Overrides unit={unit} />}
      </DialogContent>
    </Dialog>
  )
}

function Overrides({ unit }: { unit: Unit }) {
  const qc = useQueryClient()
  const rows = useQuery({
    queryKey: ['overrides', unit.id],
    queryFn: async () => {
      const { data, error } = await sb().from('rate_overrides').select('*').eq('unit_id', unit.id).order('start_date')
      if (error) throw error
      return data as RateOverrideRow[]
    },
  })
  const [label, setLabel] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [rate, setRate] = useState('')
  const overlap = rows.data?.find((r) => start && end && start <= r.end_date && end >= r.start_date)
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await sb().from('rate_overrides').insert({ unit_id: unit.id, label: label || null, start_date: start, end_date: end, nightly_rate: Number(rate) })
      if (error) throw error
    },
    onSuccess: () => { setLabel(''); setStart(''); setEnd(''); setRate(''); qc.invalidateQueries({ queryKey: ['overrides', unit.id] }); toast.success('Seasonal rate added') },
    onError: (e) => toast.error(errMessage(e)),
  })
  const del = useMutation({
    mutationFn: async (id: string) => { const { error } = await sb().from('rate_overrides').delete().eq('id', id); if (error) throw error },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['overrides', unit.id] }),
    onError: (e) => toast.error(errMessage(e)),
  })
  const valid = start && end && end >= start && Number(rate) >= 0 && rate !== ''
  return (
    <section className="mt-6 border-t pt-4" aria-labelledby="seasonal">
      <h3 id="seasonal" className="font-semibold">Seasonal & holiday rates</h3>
      <p className="mb-3 text-sm text-muted-foreground">These replace the nightly and weekend rate for the dates you choose (end date included). If ranges overlap, the newest wins.</p>
      {rows.data?.length === 0 && <p className="mb-3 text-sm text-muted-foreground">No seasonal rates yet.</p>}
      <ul className="mb-3 grid gap-2">
        {rows.data?.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span><b>{r.label || 'Seasonal rate'}</b>: {formatDate(r.start_date)} to {formatDate(r.end_date)} at {formatKES(r.nightly_rate)}</span>
            <Button variant="ghost" size="icon" aria-label="Delete seasonal rate" onClick={() => del.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button>
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Label" htmlFor="o-label"><Input id="o-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="December peak" /></Field>
        <Field label="From" htmlFor="o-from"><Input id="o-from" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="To (included)" htmlFor="o-to"><Input id="o-to" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Nightly rate" htmlFor="o-rate"><Input id="o-rate" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      {overlap && <p className="mt-2 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400"><AlertTriangle className="h-4 w-4" /> This overlaps "{overlap.label || 'another seasonal rate'}". The newest rate will apply on shared dates.</p>}
      <Button className="mt-3" variant="outline" disabled={!valid} loading={add.isPending} onClick={() => add.mutate()}>Add seasonal rate</Button>
    </section>
  )
}
