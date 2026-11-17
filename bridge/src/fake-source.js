// Fake vitals for `npm run fake`: no camera, no API key, no person.
//
// It produces the same kind of raw data the camera source does (a chest trace
// plus pulse and breathing rates) from a fixed script, so the real hold
// detector and mood logic are what drive the puppy. The numbers are invented.

import { EventEmitter } from 'node:events';

export const SCRIPT = Object.freeze([
  { name: 'calm', seconds: 16, pulse: 68, breathing: 14 },
  { name: 'held breath', seconds: 14, pulse: 70, breathing: 14, hold: true },
  { name: 'breathing again', seconds: 8, pulse: 71, breathing: 15 },
  { name: 'excited', seconds: 14, pulse: 97, breathing: 18 },
  { name: 'settling', seconds: 12, pulse: 69, breathing: 13 },
  { name: 'sleepy', seconds: 18, pulse: 66, breathing: 7 },
]);

export const SCRIPT_SECONDS = SCRIPT.reduce((sum, p) => sum + p.seconds, 0);

/** Deterministic generator: call step(dt) with small time steps. */
export class FakeVitals {
  constructor(script = SCRIPT) {
    this.script = script;
    this.total = script.reduce((sum, p) => sum + p.seconds, 0);
    this.t = 0;
    this.phase = 0;
    this.pulse = script[0].pulse;
    this.breathing = script[0].breathing;
    this.held = null;
  }

  phaseAt(t) {
    let rest = t % this.total;
    for (const p of this.script) {
      if (rest < p.seconds) return p;
      rest -= p.seconds;
    }
    return this.script[0];
  }

  step(dt) {
    this.t += dt;
    const p = this.phaseAt(this.t);
    this.pulse += (p.pulse - this.pulse) * (1 - Math.exp(-dt / 2.5));
    this.breathing += (p.breathing - this.breathing) * (1 - Math.exp(-dt / 2));

    let chest;
    if (p.hold) {
      if (this.held === null) this.held = Math.sin(this.phase);
      chest = this.held;
    } else {
      this.held = null;
      this.phase += 2 * Math.PI * (this.breathing / 60) * dt;
      chest = Math.sin(this.phase);
    }
    // Arbitrary scale and offset plus a little wobble, like a real sensor trace.
    const raw = 0.3 + 0.6 * chest + 0.012 * Math.sin(this.t * 37.1) + 0.008 * Math.sin(this.t * 91.7);
    return { t: this.t, raw, pulse: this.pulse, breathing: this.breathing, phase: p.name };
  }
}

/** Runs FakeVitals in real time with the same events as the camera source. */
export class FakeSource extends EventEmitter {
  constructor({ intervalMs = 50 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.vitals = new FakeVitals();
    this.timer = null;
    this.phase = null;
  }

  start() {
    let last = performance.now();
    let sinceRates = Infinity;
    this.emit('tracking', true, 'fake signal');
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const s = this.vitals.step(dt);
      if (s.phase !== this.phase) {
        this.phase = s.phase;
        this.emit('phase', s.phase);
      }
      this.emit('trace', s.raw, s.t);
      sinceRates += dt;
      if (sinceRates >= 1) {
        sinceRates = 0;
        this.emit('rates', { pulse: s.pulse, breathing: s.breathing });
      }
    }, this.intervalMs);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
