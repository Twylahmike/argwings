import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/')({ component: () => <PageHeader title="Dashboard" /> })
