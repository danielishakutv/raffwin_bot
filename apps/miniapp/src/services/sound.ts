/**
 * Sound effects synthesised with the Web Audio API. No audio files needed.
 * The AudioContext is created (and resumed) only after a user gesture, which
 * Telegram and mobile browsers require. See installAudioUnlock().
 */

export type SoundName =
  | 'click'
  | 'pop'
  | 'chime'
  | 'fanfare'
  | 'whoosh'
  | 'drumroll'
  | 'land'
  | 'coin'
  | 'error'
  | 'tick'

type Wave = OscillatorType

const NOISE_SECONDS = 1

interface ToneOptions {
  freq: number
  type?: Wave
  start?: number
  duration?: number
  gain?: number
  slideTo?: number
  attack?: number
}

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private musicGain: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private musicTimer: number | null = null
  private musicStep = 0
  private musicNextTime = 0
  muted = false
  musicEnabled = false

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        const Ctor =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return null
        this.ctx = new Ctor()
        this.master = this.ctx.createGain()
        this.master.gain.value = 0.55
        this.master.connect(this.ctx.destination)
      } catch (error) {
        console.warn('[sound] audio unavailable', error)
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  /** Called on the first user gesture. */
  unlock(): void {
    const ctx = this.ensure()
    if (ctx && this.musicEnabled && !this.muted) this.startMusic()
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running'
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.stopMusic()
    else if (this.musicEnabled && this.ready) this.startMusic()
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled
    if (enabled && !this.muted) this.startMusic()
    else this.stopMusic()
  }

  private tone(o: ToneOptions): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const t0 = ctx.currentTime + (o.start ?? 0)
    const dur = o.duration ?? 0.12
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(o.freq, t0)
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur)
    const peak = o.gain ?? 0.3
    const attack = o.attack ?? 0.005
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g)
    g.connect(master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  private noise(start: number, duration: number, gain: number, filterFrom: number, filterTo?: number): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const t0 = ctx.currentTime + start
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer(ctx)
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 0.8
    filter.frequency.setValueAtTime(filterFrom, t0)
    if (filterTo) filter.frequency.exponentialRampToValueAtTime(filterTo, t0 + duration)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    src.connect(filter)
    filter.connect(g)
    g.connect(master)
    // A random slice of the shared second of noise, so repeated hits do not sound identical
    src.start(t0, Math.random() * Math.max(0, NOISE_SECONDS - duration - 0.05))
    src.stop(t0 + duration + 0.02)
  }

  /** One second of white noise, made once: a drumroll used to fill ~30 fresh buffers on the spot */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuf || this.noiseBuf.sampleRate !== ctx.sampleRate) {
      const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS)
      this.noiseBuf = ctx.createBuffer(1, frames, ctx.sampleRate)
      const data = this.noiseBuf.getChannelData(0)
      for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1
    }
    return this.noiseBuf
  }

  play(name: SoundName): void {
    if (this.muted) return
    const ctx = this.ensure()
    if (!ctx || ctx.state !== 'running') return
    switch (name) {
      case 'click':
        this.tone({ freq: 1800, type: 'triangle', duration: 0.045, gain: 0.12, slideTo: 1200 })
        break
      case 'tick':
        this.tone({ freq: 900, type: 'square', duration: 0.03, gain: 0.05 })
        break
      case 'pop':
        this.tone({ freq: 320, type: 'sine', duration: 0.11, gain: 0.35, slideTo: 720 })
        this.noise(0, 0.05, 0.08, 2500, 900)
        break
      case 'whoosh':
        this.noise(0, 0.22, 0.14, 400, 3200)
        break
      case 'chime':
        this.tone({ freq: 523.25, type: 'sine', duration: 0.28, gain: 0.25 })
        this.tone({ freq: 659.25, type: 'sine', start: 0.1, duration: 0.3, gain: 0.25 })
        this.tone({ freq: 783.99, type: 'sine', start: 0.2, duration: 0.42, gain: 0.28 })
        this.tone({ freq: 1046.5, type: 'triangle', start: 0.3, duration: 0.5, gain: 0.18 })
        break
      case 'coin':
        this.tone({ freq: 987.77, type: 'square', duration: 0.08, gain: 0.12 })
        this.tone({ freq: 1318.5, type: 'square', start: 0.08, duration: 0.26, gain: 0.12 })
        break
      case 'land':
        this.tone({ freq: 220, type: 'sine', duration: 0.18, gain: 0.4, slideTo: 110 })
        this.noise(0, 0.08, 0.12, 1200, 300)
        break
      case 'error':
        this.tone({ freq: 240, type: 'sawtooth', duration: 0.16, gain: 0.12, slideTo: 180 })
        this.tone({ freq: 200, type: 'sawtooth', start: 0.17, duration: 0.2, gain: 0.12, slideTo: 140 })
        break
      case 'fanfare': {
        const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5]
        const starts = [0, 0.12, 0.24, 0.36, 0.56, 0.68, 0.8]
        notes.forEach((freq, i) => {
          this.tone({ freq, type: 'square', start: starts[i], duration: i === notes.length - 1 ? 0.7 : 0.16, gain: 0.1 })
          this.tone({ freq: freq / 2, type: 'triangle', start: starts[i], duration: i === notes.length - 1 ? 0.7 : 0.16, gain: 0.16 })
        })
        this.noise(0.8, 0.5, 0.08, 3000, 500)
        break
      }
      case 'drumroll': {
        // Accelerating hits over ~1.6s
        let t = 0
        let gap = 0.085
        while (t < 1.6) {
          this.noise(t, 0.045, 0.16, 180, 120)
          this.tone({ freq: 140, type: 'triangle', start: t, duration: 0.05, gain: 0.08, slideTo: 90 })
          t += gap
          gap = Math.max(0.028, gap * 0.94)
        }
        break
      }
      default:
        break
    }
  }

  /* ---- Background tune: a soft, looping arpeggio scheduled in small batches ---- */

  private startMusic(): void {
    const ctx = this.ensure()
    if (!ctx || !this.master || this.musicTimer !== null) return
    this.musicGain = ctx.createGain()
    this.musicGain.gain.value = 0.0001
    this.musicGain.connect(this.master)
    this.musicGain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 1.2)
    this.musicNextTime = ctx.currentTime + 0.05
    this.musicStep = 0
    const schedule = () => {
      if (!this.ctx || !this.musicGain) return
      const pattern = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63, 293.66, 349.23, 440.0, 587.33, 440.0, 349.23]
      const stepLen = 0.22
      while (this.musicNextTime < this.ctx.currentTime + 0.6) {
        const freq = pattern[this.musicStep % pattern.length]
        const osc = this.ctx.createOscillator()
        const g = this.ctx.createGain()
        osc.type = this.musicStep % 24 < 12 ? 'triangle' : 'sine'
        osc.frequency.value = freq
        g.gain.setValueAtTime(0.0001, this.musicNextTime)
        g.gain.exponentialRampToValueAtTime(1, this.musicNextTime + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, this.musicNextTime + stepLen * 0.9)
        osc.connect(g)
        g.connect(this.musicGain)
        osc.start(this.musicNextTime)
        osc.stop(this.musicNextTime + stepLen)
        if (this.musicStep % 4 === 0) {
          const bass = this.ctx.createOscillator()
          const bg = this.ctx.createGain()
          bass.type = 'sine'
          bass.frequency.value = freq / 4
          bg.gain.setValueAtTime(0.0001, this.musicNextTime)
          bg.gain.exponentialRampToValueAtTime(0.9, this.musicNextTime + 0.03)
          bg.gain.exponentialRampToValueAtTime(0.0001, this.musicNextTime + stepLen * 3.5)
          bass.connect(bg)
          bg.connect(this.musicGain)
          bass.start(this.musicNextTime)
          bass.stop(this.musicNextTime + stepLen * 4)
        }
        this.musicNextTime += stepLen
        this.musicStep += 1
      }
    }
    schedule()
    this.musicTimer = window.setInterval(schedule, 250)
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer)
      this.musicTimer = null
    }
    if (this.musicGain && this.ctx) {
      const g = this.musicGain
      g.gain.cancelScheduledValues(this.ctx.currentTime)
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.4)
      window.setTimeout(() => g.disconnect(), 500)
      this.musicGain = null
    }
  }
}

export const sound = new SoundEngine()

/** Resume/create the AudioContext on the first gesture, as required by mobile browsers and Telegram. */
export function installAudioUnlock(): () => void {
  const handler = () => {
    sound.unlock()
    remove()
  }
  const events: (keyof DocumentEventMap)[] = ['pointerdown', 'touchend', 'keydown']
  const remove = () => events.forEach((e) => document.removeEventListener(e, handler))
  events.forEach((e) => document.addEventListener(e, handler, { passive: true }))
  return remove
}
