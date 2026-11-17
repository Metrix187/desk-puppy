// Breath-hold detector.
//
// The SmartSpectra SDK has no usable apnea metric, so this watches the chest
// movement trace instead. A hold is declared when the trace has stayed nearly
// flat for about eight seconds while the person is still being tracked.
//
// "Nearly flat" is relative: the detector learns how far the trace normally
// swings over eight seconds of ordinary breathing (the reference) and compares
// the swing of the last eight seconds against a fraction of that.
//
// Real traces are messier than a sine wave. Shifting in the chair or the camera
// re-framing produces jumps several times the size of a breath. If those set the
// reference, quiet breathing looks flat by comparison and the puppy cries wolf.
// So the reference is a low percentile of recent swings rather than a typical
// or large one, learning waits for the signal to settle, and nothing is declared
// until there is about half a minute of breathing to compare against.
//
// This is a toy heuristic for an animation, not a measurement of anything.

const DEFAULTS = Object.freeze({
  holdSeconds: 8, // how long the trace must stay flat
  flatRatio: 0.2, // "flat" = swing below this fraction of the reference
  releaseRatio: 0.5, // hold ends when a short window swings above this fraction
  releaseWindowSeconds: 2,
  settleSeconds: 8, // ignore this much after tracking starts before learning
  ampHistory: 60, // how many one-per-second swing readings to remember
  minAmpReadings: 12, // readings needed before a hold can be declared
  referencePercentile: 0.35, // low on purpose, see above
  maxHoldSeconds: 75, // after this, assume the signal changed and relearn
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

  /** Forget everything, including the learned reference. */
  reset() {
    this.amps = [];
    this.lastAmpT = -Infinity;
    this.#restartWindow();
  }

  #restartWindow() {
    this.samples = [];
    this.windowStartT = null;
    this.holding = false;
    this.holdStartT = null;
    this.ratio = null;
  }

  /** Swing the trace normally shows over a hold-length window, or null while still learning. */
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
      // Without a trusted signal a flat trace means nothing. Keep the learned reference.
      this.#restartWindow();
      return false;
    }

    const last = this.samples.at(-1);
    if (last) {
      if (t <= last.t) return this.holding; // duplicate or out-of-order sample
      if (t - last.t > o.maxGapSeconds) this.#restartWindow();
    }
    if (this.windowStartT === null) this.windowStartT = t;

    this.samples.push({ t, v: value });
    while (this.samples.length && this.samples[0].t < t - o.holdSeconds - 1) this.samples.shift();

    const spanned = t - this.samples[0].t;
    const settled = t - this.windowStartT >= o.settleSeconds + o.holdSeconds;
    const full = spanned >= o.holdSeconds - 0.25;
    const { swing, n } = full ? range(this.samples, t - o.holdSeconds) : { swing: 0, n: 0 };
    const enough = n >= o.minSamplesPerSecond * o.holdSeconds;

    // Learn the normal swing, once a second, while not holding.
    if (!this.holding && settled && enough && t - this.lastAmpT >= 1) {
      const ref = this.reference;
      const looksFlat = ref !== null && swing < o.flatRatio * ref;
      if (swing > 0 && !looksFlat) {
        this.amps.push(swing);
        if (this.amps.length > o.ampHistory) this.amps.shift();
      }
      this.lastAmpT = t;
    }

    const ref = this.reference;
    this.ratio = ref !== null && enough ? swing / ref : null;
    if (ref === null) return (this.holding = false);

    if (!this.holding) {
      if (enough && swing < o.flatRatio * ref) {
        this.holding = true;
        this.holdStartT = t;
      }
    } else if (t - this.holdStartT > o.maxHoldSeconds) {
      // Flat for far too long: more likely the signal changed scale than a real
      // hold. Start over and relearn what normal looks like.
      this.reset();
    } else if (range(this.samples, t - o.releaseWindowSeconds).swing > o.releaseRatio * ref) {
      this.holding = false;
      this.holdStartT = null;
    }
    return this.holding;
  }
}
