// Decides which mood the puppy is in.
//
//   no valid signal                                   -> searching (0)
//   breath hold detected                              -> breath held (3)
//   pulse well above the session baseline             -> excited (4)
//   breathing under ~10/min and pulse not raised      -> sleepy (2)
//   otherwise                                         -> awake (1)
//
// Two kinds of hysteresis keep the puppy from flickering between moods:
// thresholds are wider for leaving a mood than for entering it, and a new mood
// has to hold steady for a short dwell time before the puppy switches.
//
// These are moods for a cartoon dog. They say nothing about anyone's health.

import { State } from './protocol.js';

const DEFAULTS = Object.freeze({
  // The baseline is the median pulse over the last few minutes of calm. A live
  // webcam pulse wanders by ten beats or so while sitting still, so a baseline
  // fixed at the start of the session goes stale within minutes.
  baselineMinSeconds: 10, // calm pulse data needed before a baseline exists
  baselineWindowSeconds: 180,

  excitedEnterBpm: 20, // above baseline to become excited (clear of the wander)
  excitedExitBpm: 12, // above baseline to stay excited

  sleepyEnterBreaths: 10, // breaths/min below which the puppy can doze
  sleepyExitBreaths: 11.5,
  // "Pulse near baseline" means not raised. A pulse below baseline is calm too.
  sleepyEnterNearBpm: 8, // at most this far above baseline to doze off
  sleepyExitNearBpm: 12, // and to stay asleep

  // Seconds a mood must persist before the puppy switches to it.
  dwell: Object.freeze({
    [State.SEARCHING]: 1.5,
    [State.AWAKE]: 2,
    [State.SLEEPY]: 4,
    [State.HOLD]: 0, // the hold detector has already waited ~8 s
    [State.EXCITED]: 3,
  }),
  leaveHoldDwell: 0.7,
});

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const known = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export class PuppyBrain {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options, dwell: { ...DEFAULTS.dwell, ...options.dwell } };
    this.state = State.SEARCHING;
    this.candidate = State.SEARCHING;
    this.candidateSince = null;
    this.baseline = null;
    this.calm = []; // one { t, pulse } a second from calm stretches
    this.calmSeconds = 0;
    this.lastT = null;
  }

  #updateBaseline(t, pulse) {
    const o = this.o;
    if (!known(pulse)) return;
    // Excitement must not drag the baseline up after it, so only calm readings
    // count. Before a baseline exists everything counts, or it could never start.
    if (this.state === State.EXCITED && this.baseline !== null) return;
    const last = this.calm.at(-1);
    if (last && t - last.t < 1) return;
    this.calm.push({ t, pulse });
    this.calmSeconds = Math.min(o.baselineWindowSeconds, this.calmSeconds + 1);
    while (this.calm.length > o.baselineWindowSeconds) this.calm.shift();
    if (this.calmSeconds >= o.baselineMinSeconds) this.baseline = median(this.calm.map((r) => r.pulse));
  }

  #target({ valid, hold, pulse, breathing }) {
    const o = this.o;
    if (!valid) return State.SEARCHING;
    if (hold) return State.HOLD;
    if (this.baseline === null || !known(pulse)) return State.AWAKE;

    const above = pulse - this.baseline;
    const excitedAt = this.state === State.EXCITED ? o.excitedExitBpm : o.excitedEnterBpm;
    if (above > excitedAt) return State.EXCITED;

    if (known(breathing)) {
      const staying = this.state === State.SLEEPY;
      const slow = breathing < (staying ? o.sleepyExitBreaths : o.sleepyEnterBreaths);
      const near = above <= (staying ? o.sleepyExitNearBpm : o.sleepyEnterNearBpm);
      if (slow && near) return State.SLEEPY;
    }
    return State.AWAKE;
  }

  /**
   * @param {object} input
   * @param {number} input.t          time in seconds (monotonic)
   * @param {boolean} input.valid     a person is tracked and data is flowing
   * @param {boolean} input.hold      the breath-hold detector's verdict
   * @param {number} [input.pulse]    beats per minute, or NaN/undefined
   * @param {number} [input.breathing] breaths per minute, or NaN/undefined
   * @returns {number} the current State
   */
  update(input) {
    const { t } = input;
    if (input.valid) this.#updateBaseline(t, input.pulse);

    const target = this.#target(input);
    if (target !== this.candidate) {
      this.candidate = target;
      this.candidateSince = t;
    }
    if (target !== this.state) {
      const dwell =
        this.state === State.HOLD && target !== State.SEARCHING
          ? this.o.leaveHoldDwell
          : this.o.dwell[target];
      if (t - this.candidateSince >= dwell) this.state = target;
    }
    this.lastT = t;
    return this.state;
  }
}
