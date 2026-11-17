// Breath-hold detector.
//
// The SmartSpectra SDK has no usable apnea metric, so this watches the chest
// movement trace instead. A hold is declared when the trace has stayed nearly
// flat for about eight seconds while the person is still being tracked.
//
// "Nearly flat" is relative: the detector learns how far the trace normally
// swings while breathing (the reference amplitude) and compares the swing of the
// last eight seconds against a fraction of that. This is a toy heuristic for an
// animation, not a measurement of anything.

const DEFAULTS = Object.freeze({
  holdSeconds: 8, // how long the trace must stay flat
  flatRatio: 0.25, // "flat" = swing below this fraction of the reference
  releaseRatio: 0.5, // hold ends when a short window swings above this fraction
  releaseWindowSeconds: 2,
  ampWindowSeconds: 5, // window used to learn the normal swing
  ampHistory: 45, // how many one-per-second swing readings to remember
  minAmpReadings: 6, // readings needed before a hold can be declared
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

  /** Forget everything, including the learned reference amplitude. */
  reset() {
    this.samples = [];
    this.amps = [];
    this.lastAmpT = -Infinity;
    this.holding = false;
    this.holdStartT = null;
  }

  /** Swing the trace normally shows while breathing, or null while still learning. */
  get reference() {
    return this.amps.length >= this.o.minAmpReadings ? percentile(this.amps, 0.75) : null;
  }

  /**
   * Feed one chest-trace sample.
   * @param {number} t        sample time in seconds (any monotonic origin)
   * @param {number} value    raw chest trace value
   * @param {boolean} tracked whether the person is currently tracked with a usable signal
   * @returns {boolean} true while a breath hold is detected
   */
  push(t, value, tracked) {
    const o = this.o;
    if (!tracked || !Number.isFinite(value) || !Number.isFinite(t)) {
      // Without tracking a flat trace means nothing. Keep the learned reference.
      this.samples = [];
      this.holding = false;
      this.holdStartT = null;
      return false;
    }

    const last = this.samples.at(-1);
    if (last && (t <= last.t || t - last.t > o.maxGapSeconds)) {
      if (t <= last.t) return this.holding; // duplicate or out-of-order sample
      this.samples = [];
      this.holding = false;
      this.holdStartT = null;
    }

    this.samples.push({ t, v: value });
    const keep = Math.max(o.holdSeconds, o.ampWindowSeconds) + 1;
    while (this.samples.length && this.samples[0].t < t - keep) this.samples.shift();

    const spanned = t - this.samples[0].t;

    // Learn the normal swing, once a second, while not holding.
    if (!this.holding && t - this.lastAmpT >= 1 && spanned >= o.ampWindowSeconds) {
      const { swing, n } = range(this.samples, t - o.ampWindowSeconds);
      const ref = this.reference;
      const looksFlat = ref !== null && swing < o.flatRatio * ref;
      if (n >= o.minSamplesPerSecond * o.ampWindowSeconds && swing > 0 && !looksFlat) {
        this.amps.push(swing);
        if (this.amps.length > o.ampHistory) this.amps.shift();
      }
      this.lastAmpT = t;
    }

    const ref = this.reference;
    if (ref === null) return (this.holding = false);

    if (!this.holding) {
      if (spanned >= o.holdSeconds - 0.25) {
        const { swing, n } = range(this.samples, t - o.holdSeconds);
        if (n >= o.minSamplesPerSecond * o.holdSeconds && swing < o.flatRatio * ref) {
          this.holding = true;
          this.holdStartT = t;
        }
      }
    } else if (t - this.holdStartT > o.maxHoldSeconds) {
      // Flat for far too long: more likely the signal changed scale than a real
      // hold. Start over and relearn what normal looks like.
      this.reset();
    } else {
      const { swing } = range(this.samples, t - o.releaseWindowSeconds);
      if (swing > o.releaseRatio * ref) {
        this.holding = false;
        this.holdStartT = null;
      }
    }
    return this.holding;
  }
}
