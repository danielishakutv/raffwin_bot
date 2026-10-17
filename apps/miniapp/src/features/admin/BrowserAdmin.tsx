/**
 * The admin in a normal browser tab (desktop): resumes this tab's session if
 * there is one, otherwise AdminScreen shows the browser sign-in form.
 * The player app never boots here.
 */
import { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import { resumeBrowser } from './adminSession'
import { AdminScreen } from './AdminScreen'

export function BrowserAdmin() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    document.title = 'Raffle Win admin'
    // resumeBrowser never rejects; it reports its own problems on the sign-in form
    void resumeBrowser().then(() => setReady(true))
  }, [])
  if (!ready) return <div className="fixed inset-0 z-40 bg-neutral-50" aria-label="Loading the admin" role="status" />
  return (
    <HashRouter>
      <AdminScreen />
    </HashRouter>
  )
}
