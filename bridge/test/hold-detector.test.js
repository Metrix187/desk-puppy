import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BreathHoldDetector } from '../src/hold-detector.js';

const HZ = 20;

/** Feeds a generated trace and returns the times at which holding switched on/off. */
function run(detector, segments, { tracked = () => true } = {}) {
  const events = [];
  let t = 0;
  let phase = 0;
  let was = false;
  let frozen = null;
  for (const seg of segments) {
    const end = t + seg.seconds;
    for (; t < end; t += 1 / HZ) {
      let v;
      if (seg.breaths) {
        phase += (2 * Math.PI * seg.breaths) / 60 / HZ;
        v = (seg.amp ?? 1) * Math.sin(phase);
        frozen = null;
      } else {
        frozen ??= Math.sin(phase);
        v = frozen + (seg.noise ?? 0.01) * Math.sin(t * 40) + (seg.drift ?? 0) * (t - (end - seg.seconds));
      }
      const now = detector.push(t, v + (seg.offset ?? 0), tracked(t));
      if (now !== was) events.push({ t: Number(t.toFixed(2)), holding: now });
      was = now;
    }
  }
  return events;
}

test('normal breathing never counts as a hold', () => {
  const events = run(new BreathHoldDetector(), [{ seconds: 120, breaths: 14 }]);
  assert.deepEqual(events, []);
});

test('slow, sleepy breathing is not a hold', () => {
  const events = run(new BreathHoldDetector(), [
    { seconds: 30, breaths: 14 },
    { seconds: 90, breaths: 6 },
  ]);
  assert.deepEqual(events, []);
});

test('a flat trace is reported after about eight seconds', () => {
  const events = run(new BreathHoldDetector(), [
    { seconds: 30, breaths: 14 },
    { seconds: 20 },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].holding, true);
  const afterStop = events[0].t - 30;
  assert.ok(afterStop >= 7.5 && afterStop <= 10, `detected ${afterStop}s after breathing stopped`);
});

test('a short pause does not trigger', () => {
  const events = run(new BreathHoldDetector(), [
    { seconds: 30, breaths: 14 },
    { seconds: 5 },
    { seconds: 30, breaths: 14 },
  ]);
  assert.deepEqual(events, []);
});

test('the hold ends quickly once breathing resumes', () => {
  const events = run(new BreathHoldDetector(), [
    { seconds: 30, breaths: 14 },
    { seconds: 15 },
    { seconds: 20, breaths: 14 },
  ]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true, false],
  );
  const afterResume = events[1].t - 45;
  assert.ok(afterResume > 0 && afterResume <= 2.5, `released ${afterResume}s after breathing resumed`);
});

test('a slightly noisy, drifting hold is still a hold', () => {
  const events = run(new BreathHoldDetector(), [
    { seconds: 30, breaths: 14 },
    { seconds: 15, noise: 0.05, drift: 0.01 },
  ]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true],
  );
});

test('no hold is declared before normal breathing has been seen', () => {
  const events = run(new BreathHoldDetector(), [{ seconds: 40, noise: 0 }]);
  assert.deepEqual(events, []);
});

test('a flat trace with nobody tracked is not a hold', () => {
  const events = run(
    new BreathHoldDetector(),
    [
      { seconds: 30, breaths: 14 },
      { seconds: 20 },
    ],
    { tracked: (t) => t < 30 },
  );
  assert.deepEqual(events, []);
});

test('losing tracking in the middle of a hold cancels it, and it needs a fresh eight seconds', () => {
  const events = run(
    new BreathHoldDetector(),
    [
      { seconds: 30, breaths: 14 },
      { seconds: 30 },
    ],
    { tracked: (t) => t < 42 || t >= 43 },
  );
  assert.deepEqual(
    events.map((e) => e.holding),
    [true, false, true],
  );
  assert.ok(events[2].t - 43 >= 7.5, 'the window restarts after tracking returns');
});

test('a gap in the trace restarts the window', () => {
  const d = new BreathHoldDetector();
  let t = 0;
  for (; t < 30; t += 0.05) d.push(t, Math.sin((2 * Math.PI * 14 * t) / 60), true);
  for (; t < 36; t += 0.05) d.push(t, 0.5, true);
  t += 3; // camera stalled
  for (const end = t + 6; t < end; t += 0.05) assert.equal(d.push(t, 0.5, true), false);
});

test('works on a trace with a different scale and offset', () => {
  const events = run(new BreathHoldDetector(), [
    { seconds: 30, breaths: 12, amp: 0.002, offset: 40 },
    { seconds: 15, noise: 0.00002, offset: 40 },
  ]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true],
  );
});

test('a hold that never ends is abandoned and the detector relearns', () => {
  const events = run(new BreathHoldDetector({ maxHoldSeconds: 30 }), [
    { seconds: 30, breaths: 14 },
    { seconds: 60 },
  ]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true, false],
  );
  assert.ok(events[1].t - events[0].t > 29);
});

test('bad samples are ignored without throwing', () => {
  const d = new BreathHoldDetector();
  assert.equal(d.push(NaN, 1, true), false);
  assert.equal(d.push(1, NaN, true), false);
  assert.equal(d.push(1, undefined, true), false);
});
