import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Wine } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatKES, parseKES } from '~/lib/money'
import { formatDateTime } from '~/lib/dates'
import { MediaPicker } from '~/components/media/MediaPicker'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/bar')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: BarPage,
})

type Cat = { id: string; name: string; active: boolean; sort: number }
type Prod = { id: string; category_id: string | null; name: string; description: string | null; price: number; image_url: string | null; available: boolean; track_stock: boolean; stock_qty: number; low_stock_level: number }
type Move = { id: string; product_id: string; kind: string; qty: number; unit_cost: number | null; unit_price: number | null; note: string | null; created_at: string }

function BarPage() {
  const [tab, setTab] = useState<'menu' | 'stock' | 'history'>('menu')
  const mods = useQuery({ queryKey: ['modules-full'], queryFn: async () => {
    const { data } = await sb().from('settings').select('key, value').in('key', ['module_bar_menu', 'module_bar_stock'])
    return Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value === true])) as Record<string, boolean>
  } })
  const q = useQuery({ queryKey: ['bar'], queryFn: async () => {
    const [c, p, m] = await Promise.all([
      sb().from('bar_categories').select('*').order('sort').order('name'),
      sb().from('bar_products').select('*').order('name'),
      sb().from('bar_stock_movements').select('id, product_id, kind, qty, unit_cost, unit_price, note, created_at').order('created_at', { ascending: false }).limit(200),
    ])
    if (c.error) throw c.error
    if (p.error) throw p.error
    return { cats: c.data as Cat[], prods: p.data as Prod[], moves: (m.data ?? []) as Move[] }
  } })
  const menuOn = mods.data?.module_bar_menu === true
  const stockOn = mods.data?.module_bar_stock === true
  return (
    <div>
      <PageHeader title="Bar menu & stock" description="Optional. Switch the menu and stock tracking on in Settings only if you really serve drinks. The public menu shows only while it is switched on." />
      {mods.data && !menuOn && !stockOn && <EmptyState icon={Wine} title="The bar modules are switched off" description="The owner can switch them on in Settings > Business." action={<Button asChild><Link to="/admin/settings">Open settings</Link></Button>} />}
      {(menuOn || stockOn) && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">Public menu: <b>{menuOn ? 'visible on the website' : 'hidden'}</b> · Stock tracking: <b>{stockOn ? 'on' : 'off'}</b></p>
          <div className="mb-4"><Tabs label="Bar" value={tab} onChange={setTab} tabs={[{ value: 'menu', label: 'Menu' }, ...(stockOn ? [{ value: 'stock' as const, label: 'Stock' }, { value: 'history' as const, label: 'Movement history' }] : [])]} /></div>
          {q.isLoading && <Skeleton className="h-48" />}
          {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
          {q.data && tab === 'menu' && <MenuTab cats={q.data.cats} prods={q.data.prods} stockOn={stockOn} />}
          {q.data && tab === 'stock' && stockOn && <StockTab prods={q.data.prods} />}
          {q.data && tab === 'history' && stockOn && <HistoryTab prods={q.data.prods} moves={q.data.moves} />}
        </>
      )}
    </div>
  )
}

function MenuTab({ cats, prods, stockOn }: { cats: Cat[]; prods: Prod[]; stockOn: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Prod | 'new' | null>(null)
  const [cat, setCat] = useState('')
  const addCat = useMutation({
    mutationFn: async () => { const { error } = await sb().from('bar_categories').insert({ name: cat.trim(), sort: cats.length + 1 }); if (error) throw new Error(error.code === '23505' ? 'That category exists.' : error.message) },
    onSuccess: () => { setCat(''); qc.invalidateQueries({ queryKey: ['bar'] }) }, onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input aria-label="New category" className="w-56" placeholder="New category, e.g. Beers" maxLength={40} value={cat} onChange={(e) => setCat(e.target.value)} />
        <Button variant="outline" disabled={cat.trim().length < 2} loading={addCat.isPending} onClick={() => addCat.mutate()}>Add category</Button>
        <Button className="ml-auto" onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> Add item</Button>
      </div>
      {prods.length === 0 ? <EmptyState icon={Wine} title="No items yet" description="Add drinks and snacks with a price." /> : (
        <TableWrap>
          <thead><tr>{['Item', 'Category', 'Price', stockOn ? 'In stock' : '', 'Status'].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{prods.map((p) => (
            <tr key={p.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setEditing(p)}>
              <td className={td}><span className="font-medium text-brand">{p.name}</span>{p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}</td>
              <td className={td}>{cats.find((c) => c.id === p.category_id)?.name ?? '—'}</td>
              <td className={td}>{formatKES(p.price)}</td>
              <td className={td}>{stockOn ? (p.track_stock ? <span className={p.stock_qty <= p.low_stock_level ? 'font-medium text-danger' : ''}>{p.stock_qty}</span> : '—') : null}</td>
              <td className={td}>{p.available ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">On menu</Badge> : <Badge className="border-border bg-muted text-muted-foreground">Hidden</Badge>}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {editing && <ProductEditor p={editing === 'new' ? null : editing} cats={cats} stockOn={stockOn} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ProductEditor({ p, cats, stockOn, onClose }: { p: Prod | null; cats: Cat[]; stockOn: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [picking, setPicking] = useState(false)
  const [v, setV] = useState({ name: p?.name ?? '', description: p?.description ?? '', price: String(p?.price ?? ''), category_id: p?.category_id ?? '', image_url: p?.image_url ?? '', available: p?.available ?? true, track_stock: p?.track_stock ?? false, low: String(p?.low_stock_level ?? 5) })
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (v.name.trim().length < 2) throw new Error('Give the item a name.')
      const price = parseKES(v.price); if (price == null) throw new Error('Enter the price in shillings.')
      const low = Number(v.low); if (!Number.isInteger(low) || low < 0) throw new Error('The low-stock level must be 0 or more.')
      const row = { name: v.name.trim(), description: v.description.trim() || null, price, category_id: v.category_id || null, image_url: v.image_url || null, available: v.available, track_stock: stockOn && v.track_stock, low_stock_level: low }
      const { error } = p ? await sb().from('bar_products').update(row).eq('id', p.id) : await sb().from('bar_products').insert(row)
      if (error) throw new Error(error.code === '23505' ? 'An item with that name already exists in this category.' : error.message)
    },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['bar'] }); onClose() }, onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={p ? p.name : 'New item'} description="What guests see on the menu.">
        <div className="grid gap-4">
          <Field label="Name" htmlFor="bp-name"><Input id="bp-name" maxLength={80} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="Description" htmlFor="bp-desc"><Textarea id="bp-desc" rows={2} maxLength={300} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Price (KES)" htmlFor="bp-price"><Input id="bp-price" inputMode="numeric" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} /></Field>
            <Field label="Category" htmlFor="bp-cat"><Select id="bp-cat" value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })}><option value="">None</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          </div>
          <div>{v.image_url && <img src={v.image_url} alt="" className="mb-2 h-24 w-24 rounded-lg object-cover" />}<Button variant="outline" onClick={() => setPicking(true)}>{v.image_url ? 'Change picture' : 'Choose picture'}</Button>{v.image_url && <Button variant="ghost" onClick={() => setV({ ...v, image_url: '' })}>Remove</Button>}</div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.available} onChange={(e) => setV({ ...v, available: e.target.checked })} /> Available (shows on the menu)</label>
          {stockOn && <>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.track_stock} onChange={(e) => setV({ ...v, track_stock: e.target.checked })} /> Track stock for this item</label>
            {v.track_stock && <Field label="Warn me at or below" htmlFor="bp-low"><Input id="bp-low" inputMode="numeric" value={v.low} onChange={(e) => setV({ ...v, low: e.target.value })} /></Field>}
          </>}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </SheetContent>
      {picking && <MediaPicker kind="image" onClose={() => setPicking(false)} onPick={(m) => { setV((s) => ({ ...s, image_url: m.url })); setPicking(false) }} />}
    </Dialog>
  )
}

function StockTab({ prods }: { prods: Prod[] }) {
  const tracked = prods.filter((p) => p.track_stock)
  const [dlg, setDlg] = useState<{ p: Prod; mode: 'purchase' | 'wastage' | 'adjustment' | 'sale' } | null>(null)
  if (tracked.length === 0) return <EmptyState icon={Wine} title="No items track stock" description="Open an item on the Menu tab and tick “Track stock”." />
  return (
    <div>
      <TableWrap>
        <thead><tr>{['Item', 'In stock', 'Alert at', ''].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{tracked.map((p) => (
          <tr key={p.id}>
            <td className={td}>{p.name}</td>
            <td className={td}><b className={p.stock_qty <= p.low_stock_level ? 'text-danger' : ''}>{p.stock_qty}</b>{p.stock_qty <= p.low_stock_level && <span className="ml-2 text-xs text-danger">Low</span>}</td>
            <td className={td}>{p.low_stock_level}</td>
            <td className={`${td} whitespace-nowrap`}>
              <Button size="sm" variant="outline" onClick={() => setDlg({ p, mode: 'purchase' })}>Received</Button>{' '}
              <Button size="sm" variant="outline" onClick={() => setDlg({ p, mode: 'sale' })}>Sale</Button>{' '}
              <Button size="sm" variant="ghost" onClick={() => setDlg({ p, mode: 'wastage' })}>Wastage</Button>{' '}
              <Button size="sm" variant="ghost" onClick={() => setDlg({ p, mode: 'adjustment' })}>Adjust</Button>
            </td>
          </tr>))}</tbody>
      </TableWrap>
      {dlg && <MoveDialog p={dlg.p} mode={dlg.mode} onClose={() => setDlg(null)} />}
    </div>
  )
}

const MODE_TEXT = { purchase: 'Stock received', wastage: 'Record wastage', adjustment: 'Adjust stock', sale: 'Record a sale' } as const
function MoveDialog({ p, mode, onClose }: { p: Prod; mode: 'purchase' | 'wastage' | 'adjustment' | 'sale'; onClose: () => void }) {
  const qc = useQueryClient()
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const [ref, setRef] = useState('')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      const n = Number(qty)
      if (!Number.isInteger(n) || n === 0 || (mode !== 'adjustment' && n < 0)) throw new Error(mode === 'adjustment' ? 'Enter a whole number (use a minus to remove stock).' : 'Enter a whole quantity above zero.')
      if (mode === 'sale') {
        let booking: string | null = null
        if (ref.trim()) {
          const { data } = await sb().from('bookings').select('id').ilike('reference', ref.trim()).maybeSingle()
          if (!data) throw new Error('No booking with that reference.')
          booking = data.id
        }
        const { error } = await sb().rpc('sell_bar_item', { p_product: p.id, p_qty: n, p_booking: booking })
        if (error) throw error
      } else {
        const { error } = await sb().rpc('record_stock_movement', { p_product: p.id, p_kind: mode, p_qty: n, p_unit_cost: mode === 'purchase' && cost ? parseKES(cost) : null, p_note: note || null })
        if (error) throw error
      }
    },
    onSuccess: () => { toast.success('Recorded'); qc.invalidateQueries({ queryKey: ['bar'] }); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={`${MODE_TEXT[mode]}: ${p.name}`} description={`Currently ${p.stock_qty} in stock.`}>
        <div className="grid gap-4">
          <Field label="Quantity" htmlFor="mv-qty"><Input id="mv-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          {mode === 'purchase' && <Field label="Cost per item (KES, optional)" htmlFor="mv-cost"><Input id="mv-cost" inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>}
          {mode === 'sale' && <Field label="Charge to booking (optional)" htmlFor="mv-ref" hint={`Adds ${formatKES(p.price)} each to the guest's bill. Leave empty for a cash sale.`}><Input id="mv-ref" placeholder="BNB-2611-0001" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
          {mode !== 'sale' && <Field label={mode === 'adjustment' ? 'Reason (required)' : 'Note'} htmlFor="mv-note"><Input id="mv-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}

function HistoryTab({ prods, moves }: { prods: Prod[]; moves: Move[] }) {
  if (moves.length === 0) return <EmptyState icon={Wine} title="No stock movements yet" />
  return (
    <TableWrap>
      <thead><tr>{['When', 'Item', 'Type', 'Quantity', 'Note'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody className="divide-y">{moves.map((m) => (
        <tr key={m.id}><td className={`${td} whitespace-nowrap`}>{formatDateTime(m.created_at)}</td><td className={td}>{prods.find((p) => p.id === m.product_id)?.name}</td><td className={`${td} capitalize`}>{m.kind}</td>
          <td className={`${td} tabular-nums ${m.qty < 0 ? 'text-danger' : 'text-emerald-700 dark:text-emerald-400'}`}>{m.qty > 0 ? '+' : ''}{m.qty}</td><td className={td}>{m.note ?? (m.unit_price ? `@ ${formatKES(m.unit_price)}` : m.unit_cost ? `cost ${formatKES(m.unit_cost)}` : '')}</td></tr>))}</tbody>
    </TableWrap>
  )
}
