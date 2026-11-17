import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowStats, median } from '../src/trace-stats.js';
import { Calibration } from '../src/calibrate.js';

const series = (seconds, fn, hz = 30) => {
  const out = [];
  for (let i = 0; i <= seconds * hz; i++) out.push({ t: i / hz, v: fn(i / hz) });
  return out;
};

test('breathing: swing is the full depth and turns match the breathing rate', () => {
  const s = windowStats(series(8, (t) => Math.sin((2 * Math.PI * 15 * t) / 60)), 8, 8);
  assert.ok(Math.abs(s.raw - 2) < 0.05);
  assert.ok(Math.abs(s.detrended - 2) < 0.3);
  assert.ok(s.reversals >= 0.35 && s.reversals <= 0.65, `turns/s ${s.reversals}`); // 2 per breath, 15 breaths/min
});

test('a slow drift has a raw swing but almost no detrended swing', () => {
  const s = windowStats(series(8, (t) => 0.1 * t), 8, 8);
  assert.ok(Math.abs(s.raw - 0.8) < 0.01);
  assert.ok(s.detrended < 0.01);
});

test('ripple is the swing inside one second', () => {
  const s = windowStats(series(8, (t) => 0.05 * Math.sin(2 * Math.PI * 1.2 * t)), 8, 8);
  assert.ok(Math.abs(s.ripple - 0.1) < 0.02, `ripple ${s.ripple}`);
});

test('too little data gives null', () => {
  assert.equal(windowStats(series(2, Math.sin), 2, 8), null);
  assert.equal(windowStats([], 0, 8), null);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('calibration walks through its phases and summarises each one', () => {
  const lines = [];
  const phases = [
    { name: 'normal 1', seconds: 20, say: 'breathe' },
    { name: 'HOLD 1', seconds: 16, hold: true, say: 'hold' },
    { name: 'normal 2', seconds: 12, say: 'breathe' },
  ];
  const cal = new Calibration({ print: (s) => lines.push(s), phases });
  let phase = 0;
  for (let t = 0; t < 60 && !cal.done; t += 1 / 30) {
    const holding = t >= 20 && t < 36;
    if (!holding) phase += (2 * Math.PI * 12) / 60 / 30;
    cal.onTrace(t, Math.sin(phase) + (holding ? 0.01 * Math.sin(t * 9) : 0));
    cal.tick();
  }
  assert.equal(cal.done, true);
  assert.equal(lines.filter((l) => l.includes('>>>')).length, 3);
  const holdRow = lines.find((l) => l.startsWith('HOLD 1'));
  assert.ok(holdRow, 'summary has a row for the hold');
  const rawMedian = Number(holdRow.split(/\s+/)[3].split('/')[1]);
  assert.ok(rawMedian < 0.1, `held breath reads as nearly flat (${rawMedian})`);
});
