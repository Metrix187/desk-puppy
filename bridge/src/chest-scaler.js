// Turns the raw chest trace (arbitrary units, arbitrary offset) into the
// -100..100 value the board draws.
//
// The centre follows the trace slowly, and the scale follows the size of recent
// breaths. The scale decays slowly on purpose: during a breath hold the trace
// should look flat on the puppy rather than having sensor noise blown up to
// full height.

export class ChestScaler {
  constructor({ centreSeconds = 6, envelopeSeconds = 25, fill = 85 } = {}) {
    this.centreSeconds = centreSeconds;
    this.envelopeSeconds = envelopeSeconds;
    this.fill = fill; // a normal breath peaks at about this value
    this.reset();
  }

  reset() {
    this.centre = null;
    this.envelope = 0;
    this.lastT = null;
    this.value = NaN;
  }

  push(t, raw) {
    if (!Number.isFinite(raw) || !Number.isFinite(t)) return this.value;
    if (this.centre === null || this.lastT === null || t - this.lastT > 3) {
      this.centre = raw;
      this.envelope = 0;
      this.lastT = t;
      this.value = 0;
      return this.value;
    }
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    this.centre += (raw - this.centre) * (1 - Math.exp(-dt / this.centreSeconds));
    const dev = raw - this.centre;
    this.envelope = Math.max(Math.abs(dev), this.envelope * Math.exp(-dt / this.envelopeSeconds));
    const scaled = this.envelope > 0 ? (dev / this.envelope) * this.fill : 0;
    this.value = Math.max(-100, Math.min(100, scaled));
    return this.value;
  }
}
