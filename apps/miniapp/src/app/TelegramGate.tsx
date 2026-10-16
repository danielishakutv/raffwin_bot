import { motion } from 'framer-motion'
import { Send } from 'lucide-react'
import { LogoMark, Wordmark } from '@/components/ui/Logo'
import { Orbs } from '@/components/ui/Orbs'
import { botLink, env } from '@/services/env'

/** Full-screen gate shown when the app is opened outside Telegram. */
export function TelegramGate() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-10 text-center">
      <Orbs />
      <motion.div
        initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 16 }}
      >
        <LogoMark size={96} className="drop-shadow-[0_20px_40px_rgba(107,44,245,0.45)]" />
      </motion.div>
      <Wordmark className="mt-5 text-3xl" />
      <h1 className="mt-8 max-w-[18ch] text-[28px] font-bold leading-tight">Open Raffle Win in Telegram</h1>
      <p className="mt-3 max-w-[32ch] text-[15px] text-mist">
        Raffle Win runs inside the Telegram app. Open the bot, press Start and tap the Open Raffle Win button.
      </p>
      <a
        href={botLink}
        className="tap mt-8 inline-flex h-14 items-center gap-2 rounded-field bg-brand px-7 font-display text-base font-bold text-white shadow-glow transition-transform active:scale-95"
      >
        <Send size={18} />
        Open in Telegram
      </a>
      <p className="mt-4 text-[13px] text-haze">@{env.botUsername}</p>
    </div>
  )
}
