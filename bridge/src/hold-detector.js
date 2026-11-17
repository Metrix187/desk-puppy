// Breath-hold detector.
//
// The SmartSpectra SDK has no usable apnea metric, so this watches the chest
// movement trace instead and reports a hold when the slow breathing wave has
// been missing from it for about eight seconds.
//
// What a real held breath looks like (measured with `npm run calibrate`):
// the trace does not go flat. The breathing wave disappears, but a fast ripple
// at about heartbeat rate stays, roughly a third the size of a breath, along
// with some slow wander. So "is it flat" is the wrong question. Instead:
//
//   1. Smooth the trace over one second. That removes most of the ripple and
//      keeps the breathing wave, which is much slower.
//   2. Measure how far the smoothed trace swings over the last eight seconds.
//   3. Compare with what is normal for this person in this session. Under
//      four tenths of normal, for a couple of seconds running, is a hold.
//
// "Normal" is learned from the session, from the quieter half of what has been
// seen: shifting in the chair makes jumps several times the size of a breath,
// and those must not set the bar. Learning waits for the signal to settle, and
// nothing is declared until there is about half a minute to compare against.
//
// This is a toy heuristic for an animation, not a measurement of anything.

const DEFAULTS = Object.freeze({
  holdSeconds: 8, // window the breathing wave must be missing from
  // Moving average that removes the heartbeat-rate ripple. One second takes out
  // most of it without also flattening fast breathing (30 breaths a minute
  // still keeps about two thirds of its swing).
  smoothSeconds: 1,
  flatRatio: 0.4, // "missing" = smoothed swing below this fraction of normal
  confirmSeconds: 1.5, // and it has to stay that way this long
  releaseRatio: 0.55, // hold ends when the window swings above this fraction...
  releaseWindowSeconds: 3, // ...or a breath this recent swings above half of normal
  settleSeconds: 8, // ignore this much after tracking starts before learning
  ampHistory: 60, // how many one-per-second swing readings to remember
  minAmpReadings: 12, // readings needed before a hold can be declared
  referencePercentile: 0.4, // "normal" comes from the quieter side, see above
  maxHoldSeconds: 45, // after this, assume breathing got shallower and relearn
  maxGapSeconds: 1.5, // a gap this long in the trace restarts the window
  minSamplesPerSecond: 2,
});

function range(samples, fromT) {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (let i = samples.length - 1; i >= 0 && samples[i].t >= fromT; i--) {
    const v = samples[i].v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n++;
  }
  return n === 0 ? { swing: 0, n } : { swing: hi - lo, n };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export class BreathHoldDetector {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.reset();
  }

  /** Forget everything, including what normal looks like. */
  reset() {
    this.amps = [];
    this.lastAmpT = -Infinity;
    this.#restartWindow();
  }

  #restartWindow() {
    this.raw = []; // recent raw samples, for smoothing
    this.rawSum = 0;
    this.samples = []; // smoothed samples
    this.windowStartT = null;
    this.flatSince = null;
    this.holding = false;
    this.holdStartT = null;
    this.ratio = null;
  }

  /** Normal eight-second swing of the smoothed trace, or null while still learning. */
  get reference() {
    return this.amps.length >= this.o.minAmpReadings
      ? percentile(this.amps, this.o.referencePercentile)
      : null;
  }

  /**
   * Feed one chest-trace sample.
   * @param {number} t        sample time in seconds (any monotonic origin)
   * @param {number} value    raw chest trace value
   * @param {boolean} tracked whether the person is tracked with a signal the SDK is happy with
   * @returns {boolean} true while a breath hold is detected
   */
  push(t, value, tracked) {
    const o = this.o;
    if (!tracked || !Number.isFinite(value) || !Number.isFinite(t)) {
      // Without a trusted signal a quiet trace means nothing. Keep what was learned.
      this.#restartWindow();
      return false;
    }

    const last = this.raw.at(-1);
    if (last) {
      if (t <= last.t) return this.holding; // duplicate or out-of-order sample
      if (t - last.t > o.maxGapSeconds) this.#restartWindow();
    }
    if (this.windowStartT === null) this.windowStartT = t;

    // Moving average over the last smoothSeconds.
    this.raw.push({ t, v: value });
    this.rawSum += value;
    while (this.raw[0].t < t - o.smoothSeconds) this.rawSum -= this.raw.shift().v;
    if (t - this.windowStartT < o.smoothSeconds) return this.holding;

    this.samples.push({ t, v: this.rawSum / this.raw.length });
    while (this.samples[0].t < t - o.holdSeconds - 1) this.samples.shift();

    const spanned = t - this.samples[0].t;
    const settled = t - this.windowStartT >= o.settleSeconds + o.holdSeconds;
    const full = spanned >= o.holdSeconds - 0.25;
    const { swing, n } = full ? range(this.samples, t - o.holdSeconds) : { swing: 0, n: 0 };
    const enough = n >= o.minSamplesPerSecond * o.holdSeconds;

    // Learn the normal swing, once a second, while not holding.
    if (!this.holding && settled && enough && t - this.lastAmpT >= 1) {
      const ref = this.reference;
      const looksHeld = ref !== null && swing < o.flatRatio * ref;
      if (swing > 0 && !looksHeld) {
        this.amps.push(swing);
        if (this.amps.length > o.ampHistory) this.amps.shift();
      }
      this.lastAmpT = t;
    }

    const ref = this.reference;
    this.ratio = ref !== null && enough ? swing / ref : null;
    if (this.ratio === null) {
      this.flatSince = null;
      return (this.holding = false);
    }

    if (!this.holding) {
      if (this.ratio < o.flatRatio) {
        this.flatSince ??= t;
        if (t - this.flatSince >= o.confirmSeconds) {
          this.holding = true;
          this.holdStartT = t;
        }
      } else {
        this.flatSince = null;
      }
    } else if (t - this.holdStartT > o.maxHoldSeconds) {
      // Quiet for far too long: more likely breathing got shallower or the
      // signal changed scale. Start over and relearn what normal looks like.
      this.reset();
    } else if (
      this.ratio > o.releaseRatio ||
      range(this.samples, t - o.releaseWindowSeconds).swing > 0.5 * ref
    ) {
      this.holding = false;
      this.holdStartT = null;
      this.flatSince = null;
    }
    return this.holding;
  }
}
