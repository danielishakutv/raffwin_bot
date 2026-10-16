/**
 * Maker credit. Shown once, on the sign-up page only (never inside the app).
 */
export function MakerFooter() {
  return (
    <footer className="mt-10 pb-4 text-center text-[11px] leading-5 text-haze">
      <p>{new Date().getFullYear()}</p>
      <p>Secure, Fast and Reliable Software</p>
      <p>Developed by Toko Technologies (a division of Toko Academy Ltd)</p>
      <p>Made in Nigeria</p>
    </footer>
  )
}
