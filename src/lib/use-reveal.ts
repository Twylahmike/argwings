import { useEffect, useRef } from 'react'

/** Adds `is-visible` to the element when it scrolls into view (pairs with `.reveal` in theme.css). */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { el.classList.add('is-visible'); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add('is-visible'); io.disconnect() } }, { threshold: 0.15 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}
