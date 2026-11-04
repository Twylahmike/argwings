const items: [string, string][] = [
  ['🏊', 'Indoor Pool Access'], ['🏋️', 'Gym Access'], ['📶', 'High-Speed WiFi'],
  ['🍳', 'Fully Equipped Kitchen'], ['🔒', '24/7 Security'], ['🚗', 'Secure Parking'],
  ['🛁', 'Luxury Bathroom'], ['📺', 'Smart TV'], ['❄️', 'Air Conditioning'], ['🛏️', 'Premium Bedding'],
]

export function Amenities() {
  return (
    <section className="bg-olive px-6 py-24 text-white" aria-labelledby="amen-h">
      <div className="mx-auto max-w-7xl text-center">
        <p className="eyebrow mb-3 text-white/70">Amenities</p>
        <h2 id="amen-h" className="section-title mb-14">Everything You Need.</h2>
        <ul className="grid grid-cols-2 gap-8 md:grid-cols-5">
          {items.map(([icon, label], i) => (
            <li key={label} className="animate-fade-up flex flex-col items-center gap-3" style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="hover-lift flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-white/10 text-3xl backdrop-blur" aria-hidden>{icon}</span>
              <span className="text-sm text-white/90">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
