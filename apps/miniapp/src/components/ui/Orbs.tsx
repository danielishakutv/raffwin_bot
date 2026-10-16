/** Floating gradient orbs behind every screen. Pure CSS transforms, aria-hidden. */
export function Orbs() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-24 -top-24 h-72 w-72 animate-float rounded-full bg-grape opacity-40 blur-3xl" />
      <div className="absolute -right-20 top-40 h-64 w-64 animate-float-slow rounded-full bg-magenta opacity-30 blur-3xl" />
      <div className="absolute left-1/3 top-[55%] h-56 w-56 animate-float rounded-full bg-electric opacity-25 blur-3xl [animation-delay:-4s]" />
      <div className="absolute -bottom-20 -right-10 h-72 w-72 animate-float-slow rounded-full bg-mint opacity-15 blur-3xl [animation-delay:-7s]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.05),transparent_60%)]" />
    </div>
  )
}
