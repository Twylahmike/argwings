/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import appCss from '~/styles/theme.css?url'
import { BrandContext, fetchBrand } from '~/lib/brand'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Book your stay' },
      { name: 'description', content: 'Book a BNB stay in Nairobi and pay by M-Pesa.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  loader: async () => ({ brand: await fetchBrand() }),
  component: RootComponent,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  const { brand } = Route.useLoaderData()
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <BrandContext.Provider value={brand}>
            <Outlet />
          </BrandContext.Provider>
          <Toaster position="top-center" richColors />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
