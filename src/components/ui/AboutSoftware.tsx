import { env } from '@/services/env'

/** "About this software" card for the settings area of the Profile screen. */
export function AboutSoftware() {
  return (
    <section className="surface rounded-card p-5">
      <h3 className="text-base font-bold">About this software</h3>
      <p className="mt-2 text-[13px] leading-5 text-mist">
        Raffle Win is a gamified raffle platform delivered as a Telegram Mini App. Members buy Raffs, enter
        raffles and win prizes from a single transparent draw per raffle.
      </p>
      <p className="mt-2 text-[13px] leading-5 text-mist">
        Built by Toko Technologies (a division of Toko Academy Ltd). The source code and design remain the
        intellectual property of Toko Technologies; the client holds a licence to use the platform. All data
        in the platform belongs to the client and nobody else.
      </p>
      <p className="mt-3 text-[12px] text-haze">
        Version {env.version} · {env.appEnv}
      </p>
    </section>
  )
}
