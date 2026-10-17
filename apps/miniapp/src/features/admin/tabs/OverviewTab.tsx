import type { AdminOverview } from '@raffwin/shared/admin-types'
import { RefreshCw } from 'lucide-react'
import { fmt, naira, when, useLoad } from '../hooks'
import { Badge, Button, Card, Err, KeyValues, Loading, Stat, TabHeading } from '../ui'

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%')

export function OverviewTab() {
  const { data: o, error, reload, busy } = useLoad<AdminOverview>('/overview', 5_000)
  return (
    <>
      <TabHeading
        title="Overview"
        sub="Refreshes every 5 seconds while this screen is open."
        aside={
          <Button size="sm" icon={<RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />} onClick={reload}>
            Refresh
          </Button>
        }
      />
      <Err message={error} />
      {!o ? (
        <Loading rows={4} />
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Players" value={fmt(o.users.total)} sub={`${fmt(o.users.signedUpToday)} new today · ${fmt(o.users.activeLast7Days)} active in 7 days`} />
            <Stat label="Raised (all time)" value={naira(o.raised.naira)} sub={`${fmt(o.raised.raffs)} Raffs at ${naira(o.raised.nairaPerRaff)} each`} />
            <Stat label="Entries today" value={fmt(o.entries.today)} sub={`${fmt(o.entries.raffsToday)} Raffs`} />
            <Stat label="Raffles" value={`${o.raffles.open} live`} sub={`${o.raffles.drafts} draft${o.raffles.drafts === 1 ? '' : 's'}`} />
          </div>

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat
              label="Phones on file"
              value={fmt(o.phones.withPhone)}
              sub={`${pct(o.phones.withPhone, o.phones.withPhone + o.phones.withoutPhone)} of players · ${fmt(o.phones.withoutPhone)} still without`}
            />
            <Stat label="Without a phone" value={fmt(o.phones.withoutPhone)} sub="Cannot be called if they win. Message them from Messages." />
            <Stat
              label="Bot reach"
              value={fmt(o.bot.reachable)}
              sub={`${pct(o.bot.reachable, o.bot.reachable + o.bot.blocked)} reachable · ${fmt(o.bot.blocked)} blocked the bot`}
            />
            <Stat label="Bot messages" value={fmt(o.bot.sentLast24h)} sub={`sent in 24 h · ${fmt(o.bot.pending)} waiting to send`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Health">
              <KeyValues
                rows={[
                  ['Ledger consistent', o.ledgerConsistent ? <Badge tone="outline">yes</Badge> : <Badge tone="solid">NO · investigate now</Badge>],
                  ['Raffs owed to players', fmt(o.raffsOutstanding)],
                  ['Pending approvals', o.pendingApprovals ? <Badge tone="solid">{o.pendingApprovals}</Badge> : '0'],
                ]}
              />
            </Card>
            <Card title="Security, last 24 h">
              <div className="grid grid-cols-4 gap-2 text-center">
                {(['critical', 'high', 'medium', 'low'] as const).map((k) => (
                  <div key={k} className={o.securityLast24h[k] && (k === 'critical' || k === 'high') ? 'rounded-lg bg-black p-2 text-white' : 'rounded-lg bg-neutral-50 p-2'}>
                    <p className="text-[20px] font-extrabold leading-none">{o.securityLast24h[k]}</p>
                    <p className="mt-1 text-[10.5px] font-bold uppercase tracking-wide opacity-70">{k}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title="Rate now" subtitle="Stars per Raff, moving 3% to 15% from the base each hour.">
            <KeyValues
              rows={[
                ['Stars per Raff', String(o.rate.starsPerRaff), 'strong'],
                ['Base', String(o.rate.baseStarsPerRaff)],
                ['Move this hour', `${o.rate.movePct > 0 ? '+' : ''}${o.rate.movePct}%`],
                ['Until', when(o.rate.expiresAt)],
              ]}
            />
          </Card>
        </div>
      )}
    </>
  )
}
