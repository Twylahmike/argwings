import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

type Theme = 'light' | 'dark'

function read(): Theme {
  try { return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light')
  // The saved theme is applied before first paint by a script in <head> (routes/__root.tsx); here we only mirror it.
  useEffect(() => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : read()) }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('theme', next) } catch { /* private mode */ }
  }
  return (
    <button onClick={toggle} className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  )
}
