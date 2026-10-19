/**
 * Which draw shows play. The server draws at the deadline; every open app
 * learns of it on its next live poll (a few seconds) and plays the show once
 * per device. Someone who opens the app later still gets the show for a draw
 * of the last SHOW_FOR_MS. "Watch the draw" replays it at any time.
 */
import { create } from 'zustand'
import type { Raffle } from '@/data/types'

/** A draw newer than this plays by itself on a device that has not shown it yet */
export const SHOW_FOR_MS = 6 * 3_600_000
const SEEN_KEY = 'raffwin_draws_seen'
/** Remembered show ids; old ones fall off the end */
const SEEN_MAX = 200

function readSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch (error) {
    console.warn('[draw] could not read which draws were shown', error)
    return []
  }
}

function writeSeen(list: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(-SEEN_MAX)))
  } catch (error) {
    // Storage blocked: the show may play again next time, nothing worse
    console.warn('[draw] could not remember a shown draw', error)
  }
}

interface DrawShowState {
  /** The raffle whose show is on screen */
  playing: string | null
  queue: string[]
  seen: string[]
  /** Plays now, or after the show on screen (replays included) */
  play: (raffleId: string) => void
  /** The show on screen ended or was skipped: remember it, start the next */
  finish: () => void
  /** Queues every recently drawn raffle this device has not shown yet */
  offer: (raffles: Raffle[], now: number) => void
}

export const useDrawShow = create<DrawShowState>((set, get) => ({
  playing: null,
  queue: [],
  seen: readSeen(),
  play(raffleId) {
    const { playing, queue } = get()
    if (playing === raffleId || queue.includes(raffleId)) return
    if (playing) set({ queue: [...queue, raffleId] })
    else set({ playing: raffleId })
  },
  finish() {
    const { playing, queue, seen } = get()
    const nextSeen = playing && !seen.includes(playing) ? [...seen, playing] : seen
    if (nextSeen !== seen) writeSeen(nextSeen)
    const [next = null, ...rest] = queue
    set({ playing: next, queue: rest, seen: nextSeen })
  },
  offer(raffles, now) {
    const { seen, play } = get()
    raffles
      .filter((r) => r.drawnAt && now - Date.parse(r.drawnAt) < SHOW_FOR_MS && !seen.includes(r.id))
      .sort((a, b) => Date.parse(a.drawnAt ?? '') - Date.parse(b.drawnAt ?? ''))
      .forEach((r) => play(r.id))
  },
}))
