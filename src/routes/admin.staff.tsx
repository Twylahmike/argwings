import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { KeyRound, Plus, UserCog } from 'lucide-react'
import { callFunction, sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import type { AppRole, Profile } from '~/lib/types'
import { formatDateTime } from '~/lib/dates'
import { errMessage } from '~/lib/utils'
import { normalizePhone } from '~/lib/phone'
import { Button } from '~/components/ui/button'
import { Field, Input, Select } from '~/components/ui/form'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Badge } from '~/components/ui/badge'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/staff')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner']),
  component: StaffPage,
})

type StaffRow = Profile & { roles: AppRole[]; propertyIds: string[]; lastActivity: string | null }

async function loadStaff(): Promise<StaffRow[]> {
  const client = sb()
  const [profiles, roles, props, audit] = await Promise.all([
    client.from('profiles').select('*').order('full_name'),
    client.from('user_roles').select('user_id, role'),
    client.from('staff_properties').select('user_id, property_id'),
    client.from('audit_log').select('user_id, created_at').not('user_id', 'is', null).order('created_at', { ascending: false }).limit(1000),
  ])
  const err = profiles.error ?? roles.error ?? props.error ?? audit.error
  if (err) throw err
  const last = new Map<string, string>()
  for (const a of audit.data ?? []) if (a.user_id && !last.has(a.user_id)) last.set(a.user_id, a.created_at)
  return (profiles.data as Profile[]).map((p) => ({
    ...p,
    roles: (roles.data ?? []).filter((r) => r.user_id === p.id).map((r) => r.role as AppRole),
    propertyIds: (props.data ?? []).filter((r) => r.user_id === p.id).map((r) => r.property_id as string),
    lastActivity: last.get(p.id) ?? null,
  }))
}

const createSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter a name'),
  email: z.string().email('Enter a valid email'),
  phone: z.string().optional(),
  password: z.string().min(10, 'At least 10 characters'),
  role: z.enum(['owner', 'manager', 'cleaner']),
})

function StaffPage() {
  const { me } = useAdmin()
  const qc = useQueryClient()
  const staff = useQuery({ queryKey: ['staff'], queryFn: loadStaff })
  const trq = useQuery({ queryKey: ['team-roles-names'], queryFn: async () => (await sb().from('team_roles').select('id, name')).data ?? [] })
  const teamNames = new Map((trq.data ?? []).map((r) => [r.id as string, r.name as string]))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<StaffRow | null>(null)
  const propsList = me.properties
  const nameOf = (id: string) => propsList.find((p) => p.id === id)?.name ?? '?'

  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => callFunction('admin-users', { action: 'set_active', user_id: v.id, active: v.active }),
    onSuccess: () => { toast.success('Updated'); qc.invalidateQueries({ queryKey: ['staff'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })

  return (
    <div>
      <PageHeader title="Users" description="Create accounts, set roles and choose which properties each person can work in."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add staff</Button>} />
      {staff.isLoading && <Skeleton className="h-48" />}
      {staff.error && <ErrorState error={staff.error} retry={() => staff.refetch()} />}
      {staff.data && staff.data.length === 0 && <EmptyState icon={UserCog} title="No staff yet" description="Add your first manager or cleaner." action={<Button onClick={() => setCreating(true)}>Add staff</Button>} />}
      {staff.data && staff.data.length > 0 && (
        <TableWrap>
          <thead><tr><th className={th}>Name</th><th className={th}>Role</th><th className={th}>Properties</th><th className={th}>Last activity</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y">
            {staff.data.map((s) => (
              <tr key={s.id}>
                <td className={td}><p className="font-medium">{s.full_name}</p>{s.phone && <p className="text-xs text-muted-foreground">{s.phone}</p>}</td>
                <td className={td}><span>{teamNames.get(s.team_role_id ?? '') ?? <span className="capitalize">{s.roles.join(', ') || 'none'}</span>}</span></td>
                <td className={td}>{s.roles.includes('owner') ? 'All' : s.propertyIds.map(nameOf).join(', ') || <span className="text-muted-foreground">None</span>}</td>
                <td className={td}>{s.lastActivity ? formatDateTime(s.lastActivity) : <span className="text-muted-foreground">No activity</span>}</td>
                <td className={td}>{s.active ? <Badge className="border-emerald-600/40 text-emerald-700 dark:text-emerald-400">Active</Badge> : <Badge className="text-muted-foreground">Deactivated</Badge>}</td>
                <td className={`${td} text-right whitespace-nowrap`}>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>Edit</Button>
                  {s.id !== me.id && (
                    <Button variant="ghost" size="sm" loading={toggle.isPending && toggle.variables?.id === s.id}
                      onClick={() => { if (s.active ? confirm(`Deactivate ${s.full_name}? They will be signed out and blocked.`) : true) toggle.mutate({ id: s.id, active: !s.active }) }}>
                      {s.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <CreateStaff open={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['staff'] }) }} />
      {editing && <EditStaff row={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['staff'] }) }} />}
    </div>
  )
}

function PropertyChecks({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { me } = useAdmin()
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-sm font-medium">Properties they can work in</legend>
      {me.properties.map((p) => (
        <label key={p.id} className="flex h-11 items-center gap-3 rounded-md border px-3 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={value.includes(p.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
          {p.name}
        </label>
      ))}
    </fieldset>
  )
}

function CreateStaff({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [props, setProps] = useState<string[]>([])
  const { register, handleSubmit, reset, watch, setError, formState: { errors, isSubmitting } } = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema), defaultValues: { role: 'cleaner' },
  })
  const role = watch('role')
  async function onSubmit(v: z.infer<typeof createSchema>) {
    let phone: string | undefined
    if (v.phone?.trim()) {
      const p = normalizePhone(v.phone)
      if (!p.ok) { setError('phone', { message: p.error }); return }
      phone = p.phone
    }
    try {
      await callFunction('admin-users', { action: 'create', ...v, phone, property_ids: role === 'owner' ? [] : props })
      toast.success('Account created. They will choose a new password at first sign in.')
      reset(); setProps([]); onDone()
    } catch (e) { toast.error(errMessage(e)) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add staff" description="Share the temporary password with them privately. They must change it when they first sign in.">
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <Field label="Full name" htmlFor="cs-name" error={errors.full_name?.message}><Input id="cs-name" {...register('full_name')} /></Field>
          <Field label="Email" htmlFor="cs-email" error={errors.email?.message}><Input id="cs-email" type="email" inputMode="email" {...register('email')} /></Field>
          <Field label="Phone (optional)" htmlFor="cs-phone" error={errors.phone?.message}><Input id="cs-phone" inputMode="tel" {...register('phone')} /></Field>
          <Field label="Temporary password" htmlFor="cs-pw" error={errors.password?.message} hint="At least 10 characters."><Input id="cs-pw" type="text" autoComplete="off" {...register('password')} /></Field>
          <Field label="Role" htmlFor="cs-role">
            <Select id="cs-role" {...register('role')}>
              <option value="cleaner">Cleaner (housekeeping only)</option>
              <option value="manager">Manager (assigned properties)</option>
              <option value="owner">Owner (everything)</option>
            </Select>
          </Field>
          {role !== 'owner' && <PropertyChecks value={props} onChange={setProps} />}
          <Button type="submit" loading={isSubmitting}>Create account</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditStaff({ row, onClose, onDone }: { row: StaffRow; onClose: () => void; onDone: () => void }) {
  const { me } = useAdmin()
  const roles = useQuery({ queryKey: ['team-roles'], queryFn: async () => {
    const { data, error } = await sb().from('team_roles').select('id, name, base_role, default_for').order('name')
    if (error) throw error
    return data as { id: string; name: string; base_role: AppRole; default_for: AppRole | null }[]
  } })
  const base = row.roles[0] ?? 'cleaner'
  const initial = row.team_role_id ?? roles.data?.find((r) => r.default_for === base)?.id ?? ''
  const [picked, setPicked] = useState<string | null>(null)
  const teamRole = picked ?? initial
  const baseRole = roles.data?.find((r) => r.id === teamRole)?.base_role ?? base
  const [props, setProps] = useState<string[]>(row.propertyIds)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      const client = sb()
      if (teamRole && teamRole !== initial) {
        const r = await client.rpc('assign_team_role', { p_user: row.id, p_role: teamRole })
        if (r.error) throw r.error
      }
      const c = await client.from('staff_properties').delete().eq('user_id', row.id)
      if (c.error) throw c.error
      if (baseRole !== 'owner' && props.length) {
        const d = await client.from('staff_properties').insert(props.map((property_id) => ({ user_id: row.id, property_id })))
        if (d.error) throw d.error
      }
      if (pw) await callFunction('admin-users', { action: 'reset_password', user_id: row.id, password: pw })
      toast.success('Saved')
      onDone()
    } catch (e) { toast.error(errMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit ${row.full_name}`}>
        <div className="grid gap-4">
          <Field label="Team role" htmlFor="es-role" hint={row.id === me.id ? 'You cannot change your own role.' : 'Sets exactly what this person can do. See Team roles for the details.'}>
            <Select id="es-role" value={teamRole} disabled={row.id === me.id || roles.isLoading} onChange={(e) => setPicked(e.target.value)}>
              {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
          {baseRole !== 'owner' && <PropertyChecks value={props} onChange={setProps} />}
          {baseRole !== 'owner' && row.id !== me.id && <OverridesEditor userId={row.id} />}
          <Field label="Reset password (optional)" htmlFor="es-pw" hint="They will be asked to choose a new one at next sign in.">
            <div className="flex gap-2"><KeyRound className="mt-3 h-4 w-4 text-muted-foreground" aria-hidden /><Input id="es-pw" type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Leave blank to keep" /></div>
          </Field>
          <Button onClick={save} loading={busy} disabled={pw.length > 0 && pw.length < 10}>Save changes</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Exceptions for one person: allow an extra permission or block one, on top of their team role. Saved immediately. */
function OverridesEditor({ userId }: { userId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const data = useQuery({ queryKey: ['overrides', userId], enabled: open, queryFn: async () => {
    const [c, o] = await Promise.all([
      sb().from('permissions_catalog').select('key, module, label').order('sort'),
      sb().from('user_permission_overrides').select('permission_key, granted').eq('user_id', userId),
    ])
    if (c.error) throw c.error
    return { catalog: c.data as { key: string; module: string; label: string }[], state: new Map((o.data ?? []).map((x) => [x.permission_key as string, x.granted as boolean])) }
  } })
  const set = useMutation({
    mutationFn: async (v: { key: string; state: 'grant' | 'deny' | 'inherit' }) => { const { error } = await sb().rpc('set_user_permission', { p_user: userId, p_perm: v.key, p_state: v.state }); if (error) throw error },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['overrides', userId] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <div className="rounded-lg border p-3">
      <button type="button" className="text-sm font-medium text-brand hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'} exceptions for this person</button>
      {open && (
        <div className="mt-3 grid gap-2">
          <p className="text-xs text-muted-foreground">Normally a person gets exactly what their team role allows. Use this only for a one-off: allow one extra thing, or block one. Changes save at once.</p>
          {data.isLoading && <Skeleton className="h-16" />}
          {data.data?.catalog.map((p) => {
            const st = data.data.state.get(p.key)
            return (
              <label key={p.key} className="flex items-center justify-between gap-3 text-sm">
                <span>{p.label} <span className="text-xs text-muted-foreground">({p.module})</span></span>
                <Select aria-label={p.label} className="h-9 w-36" value={st === undefined ? 'inherit' : st ? 'grant' : 'deny'} onChange={(e) => set.mutate({ key: p.key, state: e.target.value as 'grant' | 'deny' | 'inherit' })}>
                  <option value="inherit">Role default</option><option value="grant">Allow</option><option value="deny">Block</option>
                </Select>
              </label>)
          })}
        </div>
      )}
    </div>
  )
}
