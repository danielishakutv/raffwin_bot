import { TicketCheck } from 'lucide-react'
import { useState } from 'react'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Field, Input } from '@/components/ui/Field'
import { toast } from '@/components/ui/toastStore'
import { errorMessage } from '@/api/errors'
import { formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'

/** As typed, grouped XXXX-XXXX-XXXX-XXXX; the server checks the code itself */
function grouped(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16)
  return raw.match(/.{1,4}/g)?.join('-') ?? ''
}

/** Wallet > Redeem a code: a voucher bought from a vendor adds its Raffs. */
export function RedeemCode() {
  const redeemVoucher = useAppStore((s) => s.redeemVoucher)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const complete = code.replace(/-/g, '').length === 16

  const redeem = async () => {
    setBusy(true)
    setError(null)
    try {
      const { raffs } = await redeemVoucher(code)
      sound.play('coin')
      haptics.notify('success')
      toast.success(`${formatInt(raffs)} Raffs added to your balance`)
      setCode('')
    } catch (e) {
      haptics.notify('error')
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="surface flex flex-col gap-3 rounded-card p-4">
      <div>
        <h2 className="text-[17px] font-bold">Redeem a code</h2>
        <p className="text-[13px] text-mist">Have a voucher code? Type it here to add its Raffs.</p>
      </div>
      <Field label="Code" htmlFor="voucher" error={error}>
        <Input
          id="voucher"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="font-mono tracking-wider"
          value={code}
          invalid={!!error}
          onChange={(e) => {
            setCode(grouped(e.target.value))
            setError(null)
          }}
        />
      </Field>
      <BouncyButton block disabled={!complete || busy} icon={<TicketCheck size={18} />} onClick={() => void redeem()}>
        {busy ? 'Checking the code' : 'Redeem'}
      </BouncyButton>
    </section>
  )
}
