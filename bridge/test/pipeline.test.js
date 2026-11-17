import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.js';
import { FakeVitals, SCRIPT_SECONDS } from '../src/fake-source.js';
import { State, formatLine } from '../src/protocol.js';
import { ChestScaler } from '../src/chest-scaler.js';
import { extractMetrics, toSeconds } from '../src/metrics.js';

test('formatLine follows the serial protocol', () => {
  assert.equal(formatLine({ pulse: 72.4, breathing: 14.26, state: 1, chest: 35.2 }), 'V,72,14.3,1,35\n');
  assert.equal(formatLine({ pulse: NaN, breathing: undefined, state: 0, chest: NaN }), 'V,x,x,0,x\n');
  assert.equal(formatLine({ pulse: 0, breathing: 0, state: 2, chest: -0.2 }), 'V,x,x,2,0\n');
  assert.equal(formatLine({ pulse: 999, breathing: 99, state: 4, chest: -250 }), 'V,220,60.0,4,-100\n');
  assert.equal(formatLine({ pulse: 70, breathing: 12, state: 9, chest: 0 }), 'V,70,12.0,0,0\n');
});

test('every line fits the board\'s 64-byte buffer', () => {
  const line = formatLine({ pulse: 220, breathing: 59.94, state: 4, chest: -100 });
  assert.ok(line.length < 64);
  assert.match(line, /^V,(\d+|x),(\d+\.\d|x),[0-4],(-?\d+|x)\n$/);
});

test('chest scaler maps any trace into -100..100 and keeps a hold flat', () => {
  const scaler = new ChestScaler();
  let lo = Infinity;
  let hi = -Infinity;
  let t = 0;
  for (; t < 40; t += 0.05) {
    const v = scaler.push(t, 1000 + 0.003 * Math.sin((2 * Math.PI * 14 * t) / 60));
    assert.ok(v >= -100 && v <= 100);
    if (t > 20) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  assert.ok(hi > 60 && lo < -60, `breathing fills the range (${lo.toFixed(0)}..${hi.toFixed(0)})`);
  let holdMax = 0;
  for (const start = t; t < start + 10; t += 0.05) {
    const v = scaler.push(t, 1000 + 0.00003 * Math.sin(t * 40));
    if (t > start + 6) holdMax = Math.max(holdMax, Math.abs(v));
  }
  assert.ok(holdMax < 25, `a held breath stays near flat (${holdMax.toFixed(0)})`);
});

test('the scripted fake sequence walks the puppy through every mood', () => {
  const pipeline = new Pipeline();
  const vitals = new FakeVitals();
  const seen = [];
  const lines = [];
  pipeline.onTracking(0, true);
  const dt = 0.05;
  let sinceRates = Infinity;
  for (let i = 0; i * dt < SCRIPT_SECONDS; i++) {
    const s = vitals.step(dt);
    pipeline.onTrace(s.t, s.raw, s.t);
    sinceRates += dt;
    if (sinceRates >= 1) {
      sinceRates = 0;
      pipeline.onRates(s.t, { pulse: s.pulse, breathing: s.breathing });
    }
    if (i % 2 === 0) {
      const out = pipeline.tick(s.t);
      lines.push(out.line);
      if (seen.at(-1)?.state !== out.state) seen.push({ state: out.state, phase: s.phase, t: s.t });
    }
  }
  assert.deepEqual(
    seen.map((s) => s.state),
    [State.SEARCHING, State.AWAKE, State.HOLD, State.AWAKE, State.EXCITED, State.AWAKE, State.SLEEPY],
    JSON.stringify(seen),
  );
  assert.equal(seen[2].phase, 'held breath');
  assert.equal(seen[4].phase, 'excited');
  assert.equal(seen[6].phase, 'sleepy');
  for (const line of lines) assert.match(line, /^V,(\d+|x),(\d+\.\d|x),[0-4],(-?\d+|x)\n$/);
});

test('losing the person sends searching with no numbers, and old rates do not come back', () => {
  const p = new Pipeline();
  p.onTracking(0, true);
  let t = 0;
  for (; t < 10; t += 0.1) {
    p.onTrace(t, Math.sin(t), t);
    p.onRates(t, { pulse: 70, breathing: 14 });
    p.tick(t);
  }
  assert.equal(p.tick(t).state, State.AWAKE);
  p.onTracking(t, false);
  let out;
  for (const end = t + 3; t < end; t += 0.1) out = p.tick(t);
  assert.equal(out.line, 'V,x,x,0,x\n');
  p.onTracking(t, true);
  for (const end = t + 4; t < end; t += 0.1) {
    p.onTrace(t, Math.sin(t), t);
    out = p.tick(t);
  }
  assert.equal(out.state, State.AWAKE);
  assert.ok(Number.isNaN(out.pulse) && Number.isNaN(out.breathing));
});

test('a stalled trace counts as no signal', () => {
  const p = new Pipeline();
  p.onTracking(0, true);
  let t = 0;
  for (; t < 5; t += 0.1) {
    p.onTrace(t, Math.sin(t), t);
    p.tick(t);
  }
  let out;
  for (const end = t + 6; t < end; t += 0.1) out = p.tick(t);
  assert.equal(out.state, State.SEARCHING);
});

test('extractMetrics reads the SDK message shape and skips samples it has already seen', () => {
  const cursor = { traceT: -Infinity };
  const us = (s) => s * 1e6;
  const packet = (traceTimes) => ({
    breathing: {
      upperTrace: traceTimes.map((s) => ({ value: s / 10, stable: false, timestamp: us(s) })),
      rate: [
        { value: 13, stable: true, confidence: 80, timestamp: us(1) },
        { value: 19, stable: false, confidence: 10, timestamp: us(2) },
      ],
    },
    cardio: { pulseRate: [{ value: 71.5, stable: true, confidence: 90, timestamp: us(2) }] },
  });
  const a = extractMetrics(packet([1, 2, 3]), cursor);
  assert.deepEqual(a.trace.map((s) => s.t), [1, 2, 3]);
  assert.equal(a.pulse, 71.5);
  assert.equal(a.breathing, 13, 'the unstable reading is skipped');
  const b = extractMetrics(packet([2, 3, 4]), cursor);
  assert.deepEqual(b.trace.map((s) => s.t), [4], 'overlapping history is not replayed');
  assert.equal(extractMetrics(packet([5]), cursor, { loose: true }).breathing, 19);
  assert.deepEqual(extractMetrics({}, cursor), { trace: [], pulse: undefined, breathing: undefined });
  assert.deepEqual(extractMetrics(null, cursor).trace, []);
});

test('toSeconds accepts numbers and protobuf Long objects', () => {
  assert.equal(toSeconds(2_500_000), 2.5);
  assert.equal(toSeconds({ toNumber: () => 1_000_000 }), 1);
  assert.ok(Number.isNaN(toSeconds(0)));
  assert.ok(Number.isNaN(toSeconds(null)));
});
