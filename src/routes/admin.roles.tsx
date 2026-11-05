import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/roles')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner']),
  component: RolesPage,
})

type Role = { id: string; name: string; description: string | null; base_role: 'owner' | 'manager' | 'cleaner'; is_system: boolean }
type Perm = { key: string; module: string; label: string; sort: number }

function RolesPage() {
  const [editing, setEditing] = useState<{ role: Role | null; copyFrom?: Role } | null>(null)
  const q = useQuery({ queryKey: ['roles-admin'], queryFn: async () => {
    const [r, p, rp, u] = await Promise.all([
      sb().from('team_roles').select('*').order('is_system', { ascending: false }).order('name'),
      sb().from('permissions_catalog').select('*').order('sort'),
      sb().from('team_role_permissions').select('role_id, permission_key'),
      sb().from('profiles').select('team_role_id'),
    ])
    if (r.error) throw r.error
    if (p.error) throw p.error
    const perms = new Map<string, Set<string>>()
    for (const x of rp.data ?? []) perms.set(x.role_id as string, (perms.get(x.role_id as string) ?? new Set()).add(x.permission_key as string))
    const users = new Map<string, number>()
    for (const x of u.data ?? []) if (x.team_role_id) users.set(x.team_role_id as string, (users.get(x.team_role_id as string) ?? 0) + 1)
    return { roles: r.data as Role[], catalog: p.data as Perm[], perms, users }
  } })
  return (
    <div>
      <PageHeader title="Team roles" description="Choose exactly what each kind of staff member can do. The database enforces these permissions, not just the menus."
        actions={<Button onClick={() => setEditing({ role: null })}><Plus className="h-4 w-4" aria-hidden /> New custom role</Button>} />
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && q.data.roles.length === 0 && <EmptyState icon={ShieldCheck} title="No roles" />}
      <ul className="grid gap-3 md:grid-cols-2">
        {q.data?.roles.map((r) => (
          <li key={r.id} className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div><p className="font-semibold">{r.name}</p><p className="text-sm text-muted-foreground">{r.description}</p></div>
              {r.is_system ? <Badge className="border-border bg-muted text-muted-foreground">Built-in</Badge> : <Badge className="border-brand/40 bg-brand/10 text-brand">Custom</Badge>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{q.data.perms.get(r.id)?.size ?? 0} permissions · {q.data.users.get(r.id) ?? 0} assigned · access level: {r.base_role === 'owner' ? 'owner' : r.base_role === 'manager' ? 'office staff' : 'floor staff'}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing({ role: r })}>{r.is_system ? 'View' : 'Edit'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ role: null, copyFrom: r })}><Copy className="h-4 w-4" /> Copy</Button>
            </div>
          </li>))}
      </ul>
      {editing && q.data && <Editor role={editing.role} copyFrom={editing.copyFrom} catalog={q.data.catalog} perms={q.data.perms} inUse={editing.role ? (q.data.users.get(editing.role.id) ?? 0) > 0 : false} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ role, copyFrom, catalog, perms, inUse, onClose }: { role: Role | null; copyFrom?: Role; catalog: Perm[]; perms: Map<string, Set<string>>; inUse: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const readOnly = !!role?.is_system
  const source = role ?? copyFrom
  const [name, setName] = useState(copyFrom ? `${copyFrom.name} (copy)` : role?.name ?? '')
  const [descr, setDescr] = useState(source?.description ?? '')
  const [base, setBase] = useState<'manager' | 'cleaner'>(source?.base_role === 'cleaner' ? 'cleaner' : 'manager')
  const [sel, setSel] = useState<Set<string>>(new Set(source ? perms.get(source.id) ?? [] : []))
  const [err, setErr] = useState('')
  const modules = useMemo(() => [...new Set(catalog.map((p) => p.module))], [catalog])
  const toggle = (k: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['roles-admin'] }); qc.invalidateQueries({ queryKey: ['team-roles'] }); qc.invalidateQueries({ queryKey: ['team-roles-names'] }) }
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (name.trim().length < 3) throw new Error('Give the role a name of at least 3 letters.')
      if (sel.size === 0) throw new Error('Choose at least one permission.')
      let id = role?.id
      if (role) {
        const { error } = await sb().from('team_roles').update({ name: name.trim(), description: descr.trim() || null, base_role: base }).eq('id', role.id)
        if (error) throw error
        const del = await sb().from('team_role_permissions').delete().eq('role_id', role.id)
        if (del.error) throw del.error
      } else {
        const { data, error } = await sb().from('team_roles').insert({ name: name.trim(), description: descr.trim() || null, base_role: base }).select('id').single()
        if (error) throw new Error(error.code === '23505' ? 'A role with that name already exists.' : error.message)
        id = data.id as string
      }
      const { error } = await sb().from('team_role_permissions').insert([...sel].map((permission_key) => ({ role_id: id, permission_key })))
      if (error) throw error
    },
    onSuccess: () => { toast.success('Role saved'); refresh(); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  const del = useMutation({
    mutationFn: async () => { const { error } = await sb().from('team_roles').delete().eq('id', role!.id); if (error) throw new Error(error.code === '23503' ? 'This role is assigned to staff. Move them to another role first.' : error.message) },
    onSuccess: () => { toast.success('Role deleted'); refresh(); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={readOnly ? role!.name : role ? 'Edit role' : 'New custom role'} description={readOnly ? 'Built-in roles are fixed. Use Copy to make an editable version.' : 'Tick what this role may do.'}>
        <div className="grid gap-4">
          <Field label="Name" htmlFor="rl-name"><Input id="rl-name" maxLength={40} disabled={readOnly} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description" htmlFor="rl-desc"><Textarea id="rl-desc" rows={2} maxLength={200} disabled={readOnly} value={descr} onChange={(e) => setDescr(e.target.value)} /></Field>
          {!readOnly && <Field label="Access level" htmlFor="rl-base" hint="Office staff see bookings and money for their properties. Floor staff only see housekeeping and maintenance work."><Select id="rl-base" value={base} onChange={(e) => setBase(e.target.value as 'manager' | 'cleaner')}><option value="manager">Office staff</option><option value="cleaner">Floor staff</option></Select></Field>}
          {modules.map((m) => (
            <fieldset key={m} className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-semibold">{m}</legend>
              <div className="grid gap-1.5">
                {catalog.filter((p) => p.module === m).map((p) => (
                  <label key={p.key} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={readOnly} checked={sel.has(p.key)} onChange={(e) => toggle(p.key, e.target.checked)} /> {p.label}</label>))}
              </div>
            </fieldset>))}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          {!readOnly && <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Save role</Button>
            {role && <Button variant="outline" className="text-danger" disabled={inUse} loading={del.isPending} title={inUse ? 'Assigned to staff' : ''} onClick={() => { if (confirm('Delete this role?')) del.mutate() }}>Delete</Button>}</div>}
        </div>
      </SheetContent>
    </Dialog>
  )
}
