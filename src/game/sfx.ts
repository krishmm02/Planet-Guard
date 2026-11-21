/**
 * Tiny WebAudio synth for arcade sound effects: no audio files to download,
 * so the game starts instantly. Created lazily on the first user gesture
 * (browsers block audio before one).
 */

export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private lastShot = 0
  muted = false

  private ensure(): AudioContext | null {
    if (this.muted) return null
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = 0.22
        this.master.connect(this.ctx.destination)
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  unlock(): void {
    this.ensure()
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number): void {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + dur)
  }

  private noise(dur: number, vol: number, lowpass: number): void {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const len = Math.floor(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = lowpass
    const g = ctx.createGain()
    g.gain.value = vol
    src.connect(f).connect(g).connect(this.master)
    src.start()
  }

  shoot(): void {
    const now = performance.now()
    if (now - this.lastShot < 70) return // auto-fire would otherwise be a buzzsaw
    this.lastShot = now
    this.tone(880, 0.05, 'square', 0.05, 440)
  }
  hit(): void { this.tone(220, 0.04, 'triangle', 0.08) }
  explode(big: boolean): void { this.noise(big ? 0.6 : 0.2, big ? 0.9 : 0.4, big ? 900 : 2200) }
  earthHit(): void { this.tone(90, 0.35, 'sawtooth', 0.25, 40); this.noise(0.3, 0.5, 400) }
  nova(): void { this.tone(160, 0.7, 'sawtooth', 0.25, 1400) }
  alarm(): void { this.tone(660, 0.18, 'square', 0.12, 520); setTimeout(() => this.tone(660, 0.18, 'square', 0.12, 520), 260) }
  waveClear(): void {
    ;[523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.16, 'triangle', 0.12), i * 90))
  }
}
