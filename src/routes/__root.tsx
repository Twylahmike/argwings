/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import appCss from '~/styles/theme.css?url'
import { BrandContext, fetchBrand } from '~/lib/brand'
import { brandCss } from '~/lib/color'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#187058' },
      { title: 'Book your stay' },
      { name: 'description', content: 'Book direct and pay by M-Pesa.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
  }),
  loader: async () => ({ brand: await fetchBrand() }),
  component: RootComponent,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  const { brand } = Route.useLoaderData()
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Owner-chosen brand colour (Settings). Falls back to the defaults in styles/theme.css. */}
        {brand.brandColor && <style dangerouslySetInnerHTML={{ __html: brandCss(brand.brandColor) }} />}
        {/* Apply the saved theme before first paint to avoid a light flash in dark mode. */}
        <script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}document.documentElement.classList.add('js')" }} />
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
