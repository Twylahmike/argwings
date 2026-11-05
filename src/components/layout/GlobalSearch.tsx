import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { formatPhoneLocal } from '~/lib/phone'

type Results = {
  bookings: { id: string; reference: string; guest: string | null; status: string; check_in: string }[]
  guests: { id: string; name: string; phone: string }[]
  rooms: { id: string; name: string; property: string }[]
  inquiries: { id: string; name: string; status: string }[]
  tickets: { id: string; ticket_no: number; subject: string; status: string }[]
}

/** Header search: bookings, guests, rooms, inquiries and tickets. Press "/" to focus. Results follow the person's own access. */
export function GlobalSearch() {
  const nav = useNavigate()
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 250); return () => clearTimeout(t) }, [text])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.key === '/' && el && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable) { e.preventDefault(); ref.current?.focus() }
      if (e.key === 'Escape') { setOpen(false); ref.current?.blur() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const q = useQuery({
    queryKey: ['global-search', term], enabled: term.length >= 2, staleTime: 15_000,
    queryFn: async () => { const { data, error } = await sb().rpc('global_search', { p_q: term }); if (error) throw error; return data as Results },
  })
  const go = (fn: () => void) => { setOpen(false); setText(''); fn() }
  const r = q.data
  const total = r ? r.bookings.length + r.guests.length + r.rooms.length + r.inquiries.length + r.tickets.length : 0
  const item = 'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted'
  const head = 'px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'
  return (
    <div className="relative hidden w-full max-w-sm md:block" role="search">
      <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden />
      <input ref={ref} type="search" aria-label="Search bookings, guests and rooms" placeholder="Search…  press /" value={text} autoComplete="off"
        onChange={(e) => { setText(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="h-11 w-full rounded-md border bg-card pl-9 pr-3 text-sm" />
      {open && term.length >= 2 && (
        <div className="absolute left-0 right-0 top-12 z-50 max-h-[70vh] overflow-y-auto rounded-xl border bg-card p-1 shadow-lg" role="listbox">
          {q.isLoading && <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>}
          {q.error && <p className="px-3 py-2 text-sm text-danger">Search is not available right now.</p>}
          {r && total === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">Nothing found for “{term}”.</p>}
          {r && r.bookings.length > 0 && <><p className={head}>Bookings</p>{r.bookings.map((b) => <button key={b.id} className={item} onMouseDown={() => go(() => nav({ to: '/admin/bookings/$id', params: { id: b.id } }))}><span><b>{b.reference}</b> {b.guest}</span><span className="text-xs capitalize text-muted-foreground">{b.status.replace('_', ' ')}</span></button>)}</>}
          {r && r.guests.length > 0 && <><p className={head}>Guests</p>{r.guests.map((g) => <button key={g.id} className={item} onMouseDown={() => go(() => nav({ to: '/admin/guests/$id', params: { id: g.id } }))}><span>{g.name}</span><span className="text-xs text-muted-foreground">{formatPhoneLocal(g.phone)}</span></button>)}</>}
          {r && r.rooms.length > 0 && <><p className={head}>Rooms</p>{r.rooms.map((u) => <button key={u.id} className={item} onMouseDown={() => go(() => nav({ to: '/admin/rooms' }))}><span>{u.name}</span><span className="text-xs text-muted-foreground">{u.property}</span></button>)}</>}
          {r && r.inquiries.length > 0 && <><p className={head}>Inquiries</p>{r.inquiries.map((i) => <button key={i.id} className={item} onMouseDown={() => go(() => nav({ to: '/admin/inquiries' }))}><span>{i.name}</span><span className="text-xs capitalize text-muted-foreground">{i.status.replace('_', ' ')}</span></button>)}</>}
          {r && r.tickets.length > 0 && <><p className={head}>Support tickets</p>{r.tickets.map((t) => <button key={t.id} className={item} onMouseDown={() => go(() => nav({ to: '/admin/support' }))}><span>#{t.ticket_no} {t.subject}</span><span className="text-xs capitalize text-muted-foreground">{t.status.replace('_', ' ')}</span></button>)}</>}
        </div>
      )}
    </div>
  )
}
