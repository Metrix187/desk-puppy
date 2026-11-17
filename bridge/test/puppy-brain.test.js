import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PuppyBrain } from '../src/puppy-brain.js';
import { State } from '../src/protocol.js';

const DT = 0.1;

/** Runs the brain over segments and returns the sequence of distinct states with their start times. */
function run(brain, segments, startT = 0) {
  const changes = [];
  let t = startT;
  let state = brain.state;
  for (const seg of segments) {
    const end = t + seg.seconds;
    for (; t < end - 1e-9; t += DT) {
      const input = { valid: true, hold: false, pulse: 70, breathing: 14, ...seg, t };
      if (typeof seg.pulse === 'function') input.pulse = seg.pulse(t);
      if (typeof seg.breathing === 'function') input.breathing = seg.breathing(t);
      const next = brain.update(input);
      if (next !== state) changes.push({ t: Number(t.toFixed(1)), state: next });
      state = next;
    }
  }
  return { changes, states: changes.map((c) => c.state), end: t };
}

const calm = (seconds = 40) => ({ seconds, pulse: 70, breathing: 14 });

test('starts out searching and wakes up when a signal appears', () => {
  const brain = new PuppyBrain();
  assert.equal(brain.state, State.SEARCHING);
  const { changes } = run(brain, [calm(10)]);
  assert.deepEqual(changes.map((c) => c.state), [State.AWAKE]);
  assert.ok(changes[0].t >= 1.9 && changes[0].t <= 2.2, 'after the awake dwell time');
});

test('no valid signal means searching, whatever the numbers say', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [calm(), { seconds: 10, valid: false, hold: true, pulse: 120, breathing: 6 }]);
  assert.deepEqual(states, [State.AWAKE, State.SEARCHING]);
});

test('unknown pulse and breathing with a valid signal is awake', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [{ seconds: 20, pulse: NaN, breathing: NaN }]);
  assert.deepEqual(states, [State.AWAKE]);
});

test('a breath hold wins over everything except a lost signal', () => {
  const brain = new PuppyBrain();
  const { changes } = run(brain, [calm(), { seconds: 10, hold: true, pulse: 110, breathing: 6 }]);
  assert.deepEqual(changes.map((c) => c.state), [State.AWAKE, State.HOLD]);
  assert.equal(changes[1].t, 40, 'the hold shows immediately, the detector already waited');
});

test('the puppy stops pawing soon after the hold ends', () => {
  const brain = new PuppyBrain();
  const { changes } = run(brain, [calm(), { seconds: 10, hold: true }, calm(10)]);
  assert.deepEqual(changes.map((c) => c.state), [State.AWAKE, State.HOLD, State.AWAKE]);
  assert.ok(changes[2].t - 50 <= 1, 'back to awake within a second');
});

test('slow breathing with pulse near baseline makes the puppy sleepy', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [calm(), { seconds: 20, pulse: 68, breathing: 8 }]);
  assert.deepEqual(states, [State.AWAKE, State.SLEEPY]);
});

test('slow breathing with a raised pulse is not sleepy', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [calm(), { seconds: 20, pulse: 80, breathing: 8 }]);
  assert.deepEqual(states, [State.AWAKE]);
});

test('slow breathing without a known pulse is not sleepy', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [calm(), { seconds: 20, pulse: NaN, breathing: 8 }]);
  assert.deepEqual(states, [State.AWAKE]);
});

test('pulse well above baseline makes the puppy excited', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [calm(), { seconds: 20, pulse: 95, breathing: 18 }]);
  assert.deepEqual(states, [State.AWAKE, State.EXCITED]);
});

test('a pulse only a little above baseline is not excited', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [calm(), { seconds: 20, pulse: 80, breathing: 16 }]);
  assert.deepEqual(states, [State.AWAKE]);
});

test('nothing is sleepy or excited until a baseline exists', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [{ seconds: 8, pulse: 120, breathing: 6 }]);
  assert.deepEqual(states, [State.AWAKE]);
  assert.equal(brain.baseline, null);
});

test('the baseline is the median of the first stretch of the session', () => {
  const brain = new PuppyBrain();
  run(brain, [{ seconds: 30, pulse: (t) => (t < 3 ? 110 : 64) }]);
  assert.ok(Math.abs(brain.baseline - 64) < 1, `baseline ${brain.baseline}`);
});

test('excitement does not drag the baseline up', () => {
  const brain = new PuppyBrain();
  run(brain, [calm(), { seconds: 120, pulse: 100 }]);
  assert.ok(Math.abs(brain.baseline - 70) < 1, `baseline ${brain.baseline}`);
  assert.equal(brain.state, State.EXCITED);
});

test('hysteresis: breathing hovering around the sleepy threshold does not flicker', () => {
  const brain = new PuppyBrain();
  const hover = (t) => 10 + 0.8 * Math.sin(t * 2.1); // 9.2 .. 10.8 breaths/min
  const { states } = run(brain, [calm(), { seconds: 5, breathing: 8 }, { seconds: 120, breathing: hover }]);
  assert.deepEqual(states, [State.AWAKE, State.SLEEPY]);
});

test('hysteresis: pulse hovering around the excited threshold does not flicker', () => {
  const brain = new PuppyBrain();
  const hover = (t) => 70 + 12 + 4 * Math.sin(t * 1.7); // +8 .. +16 over baseline
  const { states } = run(brain, [calm(), { seconds: 5, pulse: 95 }, { seconds: 120, pulse: hover }]);
  assert.deepEqual(states, [State.AWAKE, State.EXCITED]);
});

test('dwell: a one-second blip does not change the mood', () => {
  const brain = new PuppyBrain();
  const { states } = run(brain, [
    calm(),
    { seconds: 1, pulse: 120 },
    calm(5),
    { seconds: 1, valid: false },
    calm(5),
    { seconds: 2, pulse: 68, breathing: 7 },
    calm(5),
  ]);
  assert.deepEqual(states, [State.AWAKE]);
});

test('sleepy puppy wakes when breathing speeds up, and when the pulse climbs', () => {
  const sleepy = { seconds: 20, pulse: 68, breathing: 8 };
  const a = run(new PuppyBrain(), [calm(), sleepy, { seconds: 10, pulse: 68, breathing: 14 }]);
  assert.deepEqual(a.states, [State.AWAKE, State.SLEEPY, State.AWAKE]);
  const b = run(new PuppyBrain(), [calm(), sleepy, { seconds: 10, pulse: 90, breathing: 8 }]);
  assert.deepEqual(b.states, [State.AWAKE, State.SLEEPY, State.EXCITED]);
});

test('excited puppy calms down when the pulse comes back', () => {
  const { states } = run(new PuppyBrain(), [calm(), { seconds: 15, pulse: 96 }, calm(15)]);
  assert.deepEqual(states, [State.AWAKE, State.EXCITED, State.AWAKE]);
});
