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
  assert.ok(afterResume > 0 && afterResume <= 3.5, `released ${afterResume}s after breathing resumed`);
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

// The next three come from a real session: shifting in the chair produced
// jumps several times the size of a breath, and quiet breathing afterwards was
// being mistaken for a hold.

const fidget = { seconds: 2, breaths: 30, amp: 6 };
const quiet = (seconds) => ({ seconds, breaths: 8 });

test('movement bigger than a breath does not make quiet breathing look like a hold', () => {
  const segments = [];
  for (let i = 0; i < 8; i++) segments.push(quiet(23), fidget);
  assert.deepEqual(run(new BreathHoldDetector(), segments), []);
});

test('a rough start does not cause false alarms once things settle', () => {
  const events = run(new BreathHoldDetector(), [{ seconds: 10, breaths: 20, amp: 5 }, quiet(150)]);
  assert.deepEqual(events, []);
});

test('a real hold is still caught in a session with movement', () => {
  const events = run(new BreathHoldDetector(), [quiet(23), fidget, quiet(23), fidget, quiet(20), { seconds: 15 }]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true],
  );
});

test('breathing at 60% of the usual depth is not a hold', () => {
  const events = run(new BreathHoldDetector(), [quiet(40), { seconds: 60, breaths: 8, amp: 0.6 }]);
  assert.deepEqual(events, []);
});

// Known limit: a real held breath only drops the trace to roughly a third of
// normal, so breathing that suddenly becomes that shallow cannot be told apart
// from one. The detector gives up after maxHoldSeconds and relearns.
test('known limit: a sudden drop to a third of the usual depth reads as a hold, then it relearns', () => {
  const events = run(new BreathHoldDetector(), [quiet(40), { seconds: 120, breaths: 8, amp: 0.3 }]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true, false],
  );
  assert.ok(events[1].t - events[0].t <= 46, 'gives up within maxHoldSeconds');
});

test('nothing is declared in the first twenty seconds, however flat', () => {
  const d = new BreathHoldDetector();
  for (let t = 0; t < 20; t += 0.05) {
    const v = t < 6 ? Math.sin((2 * Math.PI * 14 * t) / 60) : 0.3;
    assert.equal(d.push(t, v, true), false);
  }
});

// A trace shaped like the one measured with `npm run calibrate`: a breath
// swings about 1.8 units at 11 a minute, a heartbeat-rate ripple of about 0.24
// rides on top, and the baseline wanders by about 0.4 every ten seconds. During
// a hold only the breath goes away.
function realistic(plan, detector = new BreathHoldDetector()) {
  const events = [];
  let t = 0;
  let phase = 0;
  let was = false;
  for (const seg of plan) {
    const start = t;
    for (const end = t + seg.seconds; t < end; t += 1 / 30) {
      phase += (2 * Math.PI * (seg.rate ?? 11)) / 60 / 30;
      const v =
        (seg.depth ?? 1) * 0.9 * Math.sin(phase) +
        0.12 * Math.sin(2 * Math.PI * 1.3 * t) +
        0.2 * Math.sin(2 * Math.PI * 0.1 * t + 1);
      const now = detector.push(t, v, true);
      if (now !== was) events.push({ holding: now, segment: seg.name, after: Number((t - start).toFixed(1)) });
      was = now;
    }
  }
  return events;
}

const breathe = (seconds, extra = {}) => ({ name: 'breathing', seconds, ...extra });
const heldBreath = (seconds) => ({ name: 'hold', seconds, depth: 0 });

test('realistic trace: a held breath is caught even though the trace keeps rippling', () => {
  const events = realistic([breathe(45), heldBreath(16), breathe(25)]);
  assert.deepEqual(
    events.map((e) => [e.holding, e.segment]),
    [
      [true, 'hold'],
      [false, 'breathing'],
    ],
  );
  assert.ok(events[0].after >= 7 && events[0].after <= 11, `caught ${events[0].after}s into the hold`);
  assert.ok(events[1].after <= 3, `let go ${events[1].after}s after breathing resumed`);
});

test('realistic trace: two minutes of ordinary breathing raise no alarm', () => {
  assert.deepEqual(realistic([breathe(120)]), []);
});

test('realistic trace: shallower breathing is not a hold', () => {
  assert.deepEqual(realistic([breathe(45), breathe(60, { depth: 0.55 }), breathe(20)]), []);
});

test('realistic trace: slow and fast breathing are not holds', () => {
  assert.deepEqual(realistic([breathe(45), breathe(50, { rate: 6 }), breathe(40, { rate: 24 }), breathe(30, { rate: 30, depth: 1.3 })]), []);
});

test('realistic trace: a five-second pause between breaths is not a hold', () => {
  const plan = [breathe(45)];
  for (let i = 0; i < 4; i++) plan.push(heldBreath(5), breathe(12));
  assert.deepEqual(realistic(plan), []);
});

test('realistic trace: a second hold is caught after the first', () => {
  const events = realistic([breathe(45), heldBreath(16), breathe(22), heldBreath(16), breathe(14)]);
  assert.deepEqual(
    events.map((e) => e.holding),
    [true, false, true, false],
  );
});

test('bad samples are ignored without throwing', () => {
  const d = new BreathHoldDetector();
  assert.equal(d.push(NaN, 1, true), false);
  assert.equal(d.push(1, NaN, true), false);
  assert.equal(d.push(1, undefined, true), false);
});
