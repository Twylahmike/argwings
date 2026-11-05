import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sb } from '~/lib/supabase'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Input } from '~/components/ui/form'
import { EmptyState, Skeleton } from '~/components/ui/misc'

export type MediaRow = { id: string; url: string; storage_path: string; kind: 'image' | 'video'; title: string | null; alt_text: string | null; category: string; size_bytes: number | null; created_at: string }

export function useMedia() {
  return useQuery({ queryKey: ['media'], queryFn: async () => {
    const { data, error } = await sb().from('media_assets').select('*').order('created_at', { ascending: false }).limit(1000)
    if (error) throw error
    return data as MediaRow[]
  } })
}

/** Pick an existing file from the library. */
export function MediaPicker({ kind = 'image', onPick, onClose }: { kind?: 'image' | 'video' | 'any'; onPick: (m: MediaRow) => void; onClose: () => void }) {
  const media = useMedia()
  const [term, setTerm] = useState('')
  const t = term.trim().toLowerCase()
  const rows = (media.data ?? []).filter((m) => (kind === 'any' || m.kind === kind) && (!t || `${m.title ?? ''} ${m.category} ${m.alt_text ?? ''}`.toLowerCase().includes(t)))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Choose from the media library" description="Upload new files in Media library first.">
        <Input aria-label="Search media" placeholder="Search by name or category" value={term} onChange={(e) => setTerm(e.target.value)} className="mb-3" />
        {media.isLoading && <Skeleton className="h-40" />}
        {media.data && rows.length === 0 && <EmptyState title="No files found" description="Upload files in the Media library." />}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {rows.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onPick(m)} className="group block w-full overflow-hidden rounded-lg border text-left hover:border-brand focus-visible:outline focus-visible:outline-2">
                {m.kind === 'image' ? <img src={m.url} alt={m.alt_text ?? m.title ?? ''} loading="lazy" className="aspect-square w-full object-cover" /> : <video src={m.url} className="aspect-square w-full object-cover" muted preload="metadata" />}
                <span className="block truncate px-2 py-1 text-xs">{m.title || m.category}</span>
              </button>
            </li>))}
        </ul>
      </SheetContent>
    </Dialog>
  )
}
