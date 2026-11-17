// Glue between a vitals source (camera or fake) and the board: feeds the chest
// trace to the hold detector and scaler, keeps the latest rates, and produces
// one protocol line per tick. Nothing here touches the disk or the network.

import { BreathHoldDetector } from './hold-detector.js';
import { PuppyBrain } from './puppy-brain.js';
import { ChestScaler } from './chest-scaler.js';
import { State, formatLine } from './protocol.js';

export class Pipeline {
  constructor({
    detector = new BreathHoldDetector(),
    brain = new PuppyBrain(),
    scaler = new ChestScaler(),
    staleSeconds = 5, // nothing at all from the source for this long = no signal
    traceStaleSeconds = 3, // no chest samples for this long = chest unknown
    rateTtlSeconds = 20, // a rate older than this is shown as unknown
  } = {}) {
    this.detector = detector;
    this.brain = brain;
    this.scaler = scaler;
    this.staleSeconds = staleSeconds;
    this.traceStaleSeconds = traceStaleSeconds;
    this.rateTtlSeconds = rateTtlSeconds;
    // Assume someone is there until the source says otherwise; without data
    // arriving the signal is not valid anyway.
    this.tracked = true;
    this.lastDataAt = -Infinity;
    this.lastTraceAt = -Infinity;
    this.pulse = { value: NaN, at: -Infinity };
    this.breathing = { value: NaN, at: -Infinity };
    this.chest = NaN;
  }

  /** @param now seconds on the bridge's clock; @param sampleT the sample's own time in seconds */
  onTrace(now, raw, sampleT = now) {
    if (!Number.isFinite(raw)) return;
    this.lastTraceAt = now;
    this.lastDataAt = now;
    this.detector.push(sampleT, raw, this.tracked);
    this.chest = this.scaler.push(sampleT, raw);
  }

  onRates(now, { pulse, breathing } = {}) {
    if (pulse > 0) this.pulse = { value: pulse, at: now };
    if (breathing > 0) this.breathing = { value: breathing, at: now };
    if (pulse > 0 || breathing > 0) this.lastDataAt = now;
  }

  /** The source produced something, even if none of it was usable yet. */
  onData(now) {
    this.lastDataAt = now;
  }

  onTracking(now, ok) {
    if (this.tracked && !ok) {
      // Whoever comes back into view may be someone else, or the same person
      // after a walk. Old numbers should not reappear as if they were fresh.
      this.pulse.at = -Infinity;
      this.breathing.at = -Infinity;
      this.detector.push(now, NaN, false);
    }
    this.tracked = !!ok;
  }

  tick(now) {
    const valid = this.tracked && now - this.lastDataAt < this.staleSeconds;
    const traceFresh = now - this.lastTraceAt < this.traceStaleSeconds;
    const fresh = (r) => (valid && now - r.at < this.rateTtlSeconds ? r.value : NaN);
    const pulse = fresh(this.pulse);
    const breathing = fresh(this.breathing);
    const hold = valid && traceFresh && this.detector.holding;
    const state = this.brain.update({ t: now, valid, hold, pulse, breathing });
    // While searching, the board is told nothing but the mood.
    const show = state !== State.SEARCHING;
    const out = {
      pulse: show ? pulse : NaN,
      breathing: show ? breathing : NaN,
      chest: show && traceFresh ? this.chest : NaN,
      state,
      valid,
    };
    out.line = formatLine(out);
    return out;
  }
}
