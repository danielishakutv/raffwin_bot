/**
 * Reminders, come-back offer, streak rewards and transfer caps (one PUT,
 * validated with the same schema as the server), plus outbox health and the
 * rotating reminder texts, read-only.
 */
import { useEffect, useState } from 'react'
import type { AdminEngagement } from '@raffwin/shared/admin-types'
import { engagementBody } from '@raffwin/shared/admin-schemas'
import { adminCall } from '../adminSession'
import { digits, fmt, problemsOf, useAction, useLoad } from '../hooks'
import { Button, Card, Err, Field, Loading, Notice, Segmented, Stat, TextInput } from '../ui'

type NumberKey =
  | 'reminderMinHours'
  | 'reminderMaxHours'
  | 'maxRemindersPerSpell'
  | 'quietStartHour'
  | 'quietEndHour'
  | 'comebackAfterHours'
  | 'comebackCooldownDays'
  | 'transferMinRaffs'
  | 'transferDailyMaxRaffs'

type Form = Record<NumberKey, string> & { comebackRaffs: '0' | '1'; streakRewards: string }

const toForm = (e: AdminEngagement): Form => ({
  reminderMinHours: String(e.reminderMinHours),
  reminderMaxHours: String(e.reminderMaxHours),
  maxRemindersPerSpell: String(e.maxRemindersPerSpell),
  quietStartHour: String(e.quietStartHour),
  quietEndHour: String(e.quietEndHour),
  comebackAfterHours: String(e.comebackAfterHours),
  comebackCooldownDays: String(e.comebackCooldownDays),
  transferMinRaffs: String(e.transferMinRaffs),
  transferDailyMaxRaffs: String(e.transferDailyMaxRaffs),
  comebackRaffs: e.comebackRaffs >= 1 ? '1' : '0',
  streakRewards: e.streakRewards.join(', '),
})

/** Empty stays NaN so the schema says "expected number" instead of silently sending 0 */
const n = (v: string) => (v.trim() === '' ? NaN : Number(v))

const hour = (h: string) => (h === '' ? '--:--' : `${h.padStart(2, '0')}:00`)

export function EngagementSettings({ canWrite }: { canWrite: boolean }) {
  const { data: e, error, setData } = useLoad<AdminEngagement>('/engagement', 30_000)
  const action = useAction()
  const [form, setForm] = useState<Form | null>(null)
  const [dirty, setDirty] = useState(false)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)

  // Fill the form from the server, but never overwrite unsaved edits on the 30 s refresh
  useEffect(() => {
    if (e && !dirty) setForm(toForm(e))
  }, [e, dirty])

  const edit = (patch: Partial<Form>) => {
    if (!form) return
    setForm({ ...form, ...patch })
    setDirty(true)
  }

  const save = async () => {
    if (!form) return
    const rewards = form.streakRewards
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : NaN))
    const parsed = engagementBody.safeParse({
      reminderMinHours: n(form.reminderMinHours),
      reminderMaxHours: n(form.reminderMaxHours),
      maxRemindersPerSpell: n(form.maxRemindersPerSpell),
      quietStartHour: n(form.quietStartHour),
      quietEndHour: n(form.quietEndHour),
      comebackAfterHours: n(form.comebackAfterHours),
      comebackRaffs: Number(form.comebackRaffs),
      comebackCooldownDays: n(form.comebackCooldownDays),
      streakRewards: rewards,
      transferMinRaffs: n(form.transferMinRaffs),
      transferDailyMaxRaffs: n(form.transferDailyMaxRaffs),
    })
    if (!parsed.success) {
      const p = problemsOf(parsed.error.issues)
      // Any bad day in the list is reported on the list's field
      for (const k of Object.keys(p)) if (k.startsWith('streakRewards.')) p.streakRewards ??= 'Whole numbers of Raffs, 0 to 1000, separated by commas'
      setProblems(p)
      return
    }
    setProblems({})
    const saved = await action.run(() => adminCall<AdminEngagement>('PUT', '/engagement', parsed.data))
    if (saved) {
      // The saved object is the new baseline: the fill effect re-runs with it, not with the values loaded before the save
      setData(saved)
      setDirty(false)
      setForm(toForm(saved))
      setMsg('Saved. New reminders and offers follow these settings from the next minute.')
    }
  }

  const field = (k: NumberKey, label: string, hint?: string, max = 7) => (
    <Field label={label} hint={hint} error={problems[k]}>
      <TextInput inputMode="numeric" value={form?.[k] ?? ''} disabled={!canWrite} onChange={(ev) => edit({ [k]: digits(ev.target.value).slice(0, max) } as Partial<Form>)} />
    </Field>
  )

  return (
    <div className="grid gap-4">
      <Err message={error ?? action.error} />
      {msg && (
        <Notice tone="success" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}
      {!e || !form ? (
        <Loading rows={3} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Waiting to send" value={fmt(e.outbox.pending)} />
            <Stat label="Sent, 24 h" value={fmt(e.outbox.sentLast24h)} />
            <Stat label="Failed, 24 h" value={fmt(e.outbox.failedLast24h)} sub={e.outbox.failedLast24h ? 'See the Outbox for the reasons' : undefined} />
            <Stat label="Blocked the bot" value={fmt(e.outbox.blockedPlayers)} sub="Cannot be messaged" />
          </div>

          {!canWrite && <Notice>Your role can see these settings; only a super admin changes them.</Notice>}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Reminders" subtitle="When a player has not opened the app for a random time between the minimum and maximum, the bot reminds them.">
              <div className="grid gap-3 sm:grid-cols-2">
                {field('reminderMinHours', 'After at least (hours)', undefined, 2)}
                {field('reminderMaxHours', 'And at most (hours)', undefined, 2)}
                {field('maxRemindersPerSpell', 'Most reminders before they open the app again', 'Then the bot goes quiet until they come back. 0 = none.', 2)}
                <div className="hidden sm:block" />
                {field('quietStartHour', 'Quiet hours start (0-23)', 'Lagos time', 2)}
                {field('quietEndHour', 'Quiet hours end (0-23)', 'Lagos time', 2)}
              </div>
              <p className="mt-3 text-[12px] text-neutral-600">
                No messages between {hour(form.quietStartHour)} and {hour(form.quietEndHour)} Lagos time; reminders due then wait until the end of quiet hours.
              </p>
            </Card>

            <Card title="Come-back offer" subtitle="A player away this long is offered free Raffs, credited the next time they open the app.">
              <div className="grid gap-3 sm:grid-cols-2">
                {field('comebackAfterHours', 'Away for at least (hours)', '48 = 2 days', 4)}
                {field('comebackCooldownDays', 'At most one offer every (days)', undefined, 2)}
                <Field group label="Raffs offered" hint="At most 1 Raff. 0 turns the offer off.">
                  <Segmented<'0' | '1'>
                    value={form.comebackRaffs}
                    onChange={(comebackRaffs) => canWrite && edit({ comebackRaffs })}
                    options={[
                      { value: '0', label: '0 (off)' },
                      { value: '1', label: '1 Raff' },
                    ]}
                  />
                </Field>
              </div>
            </Card>

            <Card title="Daily streak rewards" subtitle="Raffs for day 1, day 2, and so on; the last number repeats for longer streaks.">
              <Field label="Rewards by day" hint="e.g. 1, 1, 2, 2, 3, 3, 5" error={problems.streakRewards}>
                <TextInput value={form.streakRewards} disabled={!canWrite} onChange={(ev) => edit({ streakRewards: ev.target.value.replace(/[^0-9,;\s]/g, '') })} />
              </Field>
            </Card>

            <Card title="Send Raffs limits" subtitle="For players sending Raffs to each other, when that feature is on.">
              <div className="grid gap-3 sm:grid-cols-2">
                {field('transferMinRaffs', 'Smallest transfer (Raffs)')}
                {field('transferDailyMaxRaffs', 'Most a player sends per day (Raffs)', 'Lagos day')}
              </div>
            </Card>
          </div>

          {canWrite && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="solid" busy={action.busy} disabled={!dirty} onClick={() => void save()}>
                Save settings
              </Button>
              {dirty && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDirty(false)
                    setProblems({})
                    setForm(toForm(e))
                  }}
                >
                  Discard changes
                </Button>
              )}
              {problems[''] && <span className="text-[12.5px] font-semibold">⚠ {problems['']}</span>}
            </div>
          )}

          <Card title="Reminder texts" subtitle={`${e.reminderTexts.length} texts in rotation. A player never gets the same one twice within 48 hours. {name} becomes their first name.`} bodyClassName="p-0">
            {e.reminderTexts.length === 0 ? (
              <p className="p-4 text-[13px] text-neutral-600">No reminder texts are loaded on the server.</p>
            ) : (
              <ul className="divide-y divide-black/10">
                {e.reminderTexts.map((t) => (
                  <li key={t.key} className="flex gap-3 px-4 py-2.5 text-[13px]">
                    <span className="w-9 shrink-0 font-mono text-[12px] text-neutral-500">{t.key}</span>
                    <span className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{t.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
