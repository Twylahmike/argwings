import { useQuery } from '@tanstack/react-query'
import { sb } from './supabase'

/**
 * What the signed-in person may do, from the database (my_permissions). Used only to tidy the menu: every
 * action is still checked by the database, so hiding a link here is never the security boundary.
 */
export function usePermissions() {
  const q = useQuery({
    queryKey: ['my-permissions'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await sb().rpc('my_permissions')
      if (error) return null            // older database without roles yet: show everything the role allows
      return new Set((data as string[] | null) ?? [])
    },
  })
  const set = q.data
  return { loaded: !q.isLoading, can: (perm?: string) => !perm || set == null || set.has(perm) }
}
