import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ImagePlus, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { uploadImage } from '~/lib/images'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'

/** Upload, reorder, remove (and optionally pick a cover). Parent persists the arrays. */
export function ImageManager({
  urls, onChange, folder, cover, onCoverChange,
}: { urls: string[]; onChange: (urls: string[]) => void; folder: string; cover?: string | null; onCoverChange?: (url: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function add(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    try {
      const added: string[] = []
      for (const f of Array.from(files)) added.push(await uploadImage(f, folder))
      onChange([...urls, ...added])
      if (onCoverChange && !cover && added[0]) onCoverChange(added[0])
      toast.success(`${added.length} photo${added.length > 1 ? 's' : ''} uploaded`)
    } catch (e) {
      toast.error(errMessage(e, 'Upload failed. Please try again.'))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  const move = (i: number, d: -1 | 1) => {
    const next = [...urls]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const remove = (i: number) => {
    const url = urls[i]
    onChange(urls.filter((_, k) => k !== i))
    if (cover === url) onCoverChange?.(urls.find((_, k) => k !== i) ?? null)
  }

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {urls.map((u, i) => (
          <figure key={u} className="overflow-hidden rounded-lg border bg-card">
            <img src={u} alt={`Photo ${i + 1}`} className="aspect-[4/3] w-full object-cover" loading="lazy" />
            <figcaption className="flex items-center justify-between gap-1 p-1">
              <div className="flex">
                <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}><ArrowLeft className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="Move later" disabled={i === urls.length - 1} onClick={() => move(i, 1)}><ArrowRight className="h-4 w-4" /></Button>
              </div>
              <div className="flex">
                {onCoverChange && (
                  <Button variant="ghost" size="icon" className="h-10 w-10" aria-label={cover === u ? 'Cover photo' : 'Make cover photo'} aria-pressed={cover === u} onClick={() => onCoverChange(u)}>
                    <Star className={`h-4 w-4 ${cover === u ? 'fill-amber-400 text-amber-500' : ''}`} />
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="h-10 w-10 text-danger" aria-label="Remove photo" onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => add(e.target.files)} />
      <div><Button variant="outline" loading={busy} onClick={() => input.current?.click()}><ImagePlus className="h-4 w-4" /> Add photos</Button></div>
    </div>
  )
}
