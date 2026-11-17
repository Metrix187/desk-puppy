// Guided tuning run for the breath-hold detector: `npm run calibrate`.
//
// It tells you when to breathe normally and when to hold, and prints how the
// chest trace behaved in each phase. Because the phases are labelled, the
// numbers show directly what separates a held breath from breathing on this
// camera and this person. Everything goes to the terminal; nothing is saved.

import { windowStats, median } from './trace-stats.js';

export const PHASES = Object.freeze([
  { name: 'settle', seconds: 12, say: 'Get comfortable and breathe normally.' },
  { name: 'normal 1', seconds: 34, say: 'Breathe normally. Sit as you usually would.' },
  { name: 'HOLD 1', seconds: 16, hold: true, say: 'HOLD YOUR BREATH NOW and sit still.' },
  { name: 'normal 2', seconds: 22, say: 'Breathe again, normally.' },
  { name: 'HOLD 2', seconds: 16, hold: true, say: 'HOLD YOUR BREATH NOW and sit still.' },
  { name: 'normal 3', seconds: 14, say: 'Breathe again. Nearly done.' },
]);

const WINDOW = 8;

export class Calibration {
  constructor({ print = console.log, phases = PHASES } = {}) {
    this.print = print;
    this.phases = phases;
    this.samples = [];
    this.startT = null;
    this.phaseIndex = -1;
    this.rows = [];
    this.lastSecond = -1;
    this.done = false;
  }

  /** Feed every chest sample. `t` in seconds, `v` raw. */
  onTrace(t, v) {
    if (this.startT === null) this.startT = t;
    this.samples.push({ t, v });
    while (this.samples.length && this.samples[0].t < t - WINDOW - 2) this.samples.shift();
    this.latest = t;
  }

  #phaseAt(elapsed) {
    let start = 0;
    for (let i = 0; i < this.phases.length; i++) {
      const end = start + this.phases[i].seconds;
      if (elapsed < end) return { index: i, into: elapsed - start, left: end - elapsed };
      start = end;
    }
    return null;
  }

  /** Call about ten times a second. Returns true when the run has finished. */
  tick() {
    if (this.done || this.startT === null) return this.done;
    const elapsed = this.latest - this.startT;
    const at = this.#phaseAt(elapsed);
    if (!at) {
      this.#summary();
      this.done = true;
      return true;
    }
    if (at.index !== this.phaseIndex) {
      this.phaseIndex = at.index;
      const p = this.phases[at.index];
      this.print(`\n\x07>>> ${p.say}  (${p.seconds} seconds)\n`);
    }
    const second = Math.floor(elapsed);
    if (second === this.lastSecond) return false;
    this.lastSecond = second;

    const p = this.phases[at.index];
    const s8 = windowStats(this.samples, this.latest, WINDOW);
    const s5 = windowStats(this.samples, this.latest, 5);
    if (!s8 || !s5) return false;

    // The last second of the trace at about 6 samples a second, centred on the
    // 8 s mean and in units of the 8 s swing, so its shape can be read off.
    const recent = this.samples.filter((s) => s.t > this.latest - 1);
    const step = Math.max(1, Math.floor(recent.length / 6));
    const shape = [];
    for (let i = 0; i < recent.length; i += step) {
      shape.push(Math.round((100 * (recent[i].v - s8.mean)) / (s8.raw || 1)));
    }

    // Only windows that lie entirely inside the phase describe that phase.
    const pure = at.into >= WINDOW;
    this.rows.push({ phase: p.name, hold: !!p.hold, pure, s8, s5 });
    const e = (x) => x.toExponential(2);
    this.print(
      `[cal] ${p.name.padEnd(8)} ${String(Math.ceil(at.left)).padStart(2)}s left  raw8=${e(s8.raw)} slow8=${e(s8.slow)} det8=${e(s8.detrended)} det5=${e(s5.detrended)} ripple=${e(s8.ripple)} turns/s=${s8.reversals.toFixed(2)}${pure ? '' : ' (mixed)'}  trace=[${shape.join(',')}]`,
    );
    return false;
  }

  #summary() {
    const normal = this.rows.filter((r) => !r.hold && r.pure && r.phase !== 'settle');
    const base = {
      raw8: median(normal.map((r) => r.s8.raw)),
      slow8: median(normal.map((r) => r.s8.slow)),
      det8: median(normal.map((r) => r.s8.detrended)),
      det5: median(normal.map((r) => r.s5.detrended)),
      ripple: median(normal.map((r) => r.s8.ripple)),
    };
    this.print('\n=== Summary: each number is relative to the median of normal breathing ===');
    this.print('slow8 is what the hold detector uses: a hold needs it to stay under 0.40.');
    this.print('phase      n   raw8 min/med/max      slow8 min/med/max     det8 min/med/max      det5 min/med/max      ripple min/med/max    turns/s med');
    const names = [...new Set(this.rows.map((r) => r.phase))];
    for (const name of names) {
      const rows = this.rows.filter((r) => r.phase === name && r.pure);
      if (!rows.length) continue;
      const col = (pick, ref) => {
        const v = rows.map(pick).map((x) => x / (ref || 1));
        return `${Math.min(...v).toFixed(2)}/${median(v).toFixed(2)}/${Math.max(...v).toFixed(2)}`.padEnd(22);
      };
      this.print(
        `${name.padEnd(10)} ${String(rows.length).padStart(2)}  ${col((r) => r.s8.raw, base.raw8)}${col((r) => r.s8.slow, base.slow8)}${col((r) => r.s8.detrended, base.det8)}${col((r) => r.s5.detrended, base.det5)}${col((r) => r.s8.ripple, base.ripple)}${median(rows.map((r) => r.s8.reversals)).toFixed(2)}`,
      );
    }
    this.print('=== End of calibration. Nothing was saved. ===\n');
  }
}
