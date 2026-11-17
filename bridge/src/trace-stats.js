// Descriptive numbers for a stretch of the chest trace. Used by the hold
// detector's tuning mode (--calibrate) to see how a real held breath differs
// from real breathing. Pure functions, no state.

/** Samples within the last `seconds` before `now`. */
function tail(samples, now, seconds) {
  let i = samples.length;
  while (i > 0 && samples[i - 1].t > now - seconds) i--;
  return samples.slice(i);
}

/**
 * @param samples [{ t, v }] in time order
 * @returns null if there is too little data, otherwise
 *   raw        max - min
 *   detrended  max - min after removing the best-fit straight line (ignores slow drift)
 *   reversals  direction changes per second, ignoring wiggles under a tenth of the swing
 *   ripple     typical swing inside one second (median of 1 s max - min)
 */
export function windowStats(samples, now, seconds) {
  const w = tail(samples, now, seconds);
  if (w.length < 8 || w.at(-1).t - w[0].t < seconds * 0.8) return null;

  let lo = Infinity;
  let hi = -Infinity;
  let st = 0;
  let sv = 0;
  for (const s of w) {
    if (s.v < lo) lo = s.v;
    if (s.v > hi) hi = s.v;
    st += s.t;
    sv += s.v;
  }
  const mt = st / w.length;
  const mv = sv / w.length;
  let num = 0;
  let den = 0;
  for (const s of w) {
    num += (s.t - mt) * (s.v - mv);
    den += (s.t - mt) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  let rlo = Infinity;
  let rhi = -Infinity;
  for (const s of w) {
    const r = s.v - mv - slope * (s.t - mt);
    if (r < rlo) rlo = r;
    if (r > rhi) rhi = r;
  }
  const detrended = rhi - rlo;

  // Direction changes, with a dead band so sensor fuzz does not count.
  const band = 0.1 * detrended;
  let turns = 0;
  let dir = 0;
  let extreme = w[0].v - mv - slope * (w[0].t - mt);
  let firstLo = extreme;
  let firstHi = extreme;
  for (const s of w) {
    const r = s.v - mv - slope * (s.t - mt);
    if (dir === 0) {
      // Not moving in a known direction yet: wait for the first clear move.
      if (r < firstLo) firstLo = r;
      if (r > firstHi) firstHi = r;
      if (r - firstLo > band) dir = 1;
      else if (firstHi - r > band) dir = -1;
      extreme = r;
    } else if (dir > 0) {
      if (r > extreme) extreme = r;
      else if (extreme - r > band) {
        turns++;
        dir = -1;
        extreme = r;
      }
    } else if (r < extreme) extreme = r;
    else if (r - extreme > band) {
      turns++;
      dir = 1;
      extreme = r;
    }
  }

  // Swing within each one-second slice.
  const slices = [];
  for (let end = now; end - 1 >= now - seconds - 1e-9; end -= 1) {
    let a = Infinity;
    let b = -Infinity;
    let n = 0;
    for (const s of w) {
      if (s.t > end - 1 && s.t <= end) {
        if (s.v < a) a = s.v;
        if (s.v > b) b = s.v;
        n++;
      }
    }
    if (n >= 3) slices.push(b - a);
  }
  slices.sort((x, y) => x - y);
  const ripple = slices.length ? slices[slices.length >> 1] : 0;

  // Swing of the one-second moving average: what is left once the fast ripple
  // is smoothed away. This is the number the hold detector uses.
  let slo = Infinity;
  let shi = -Infinity;
  let sum = 0;
  let head = 0;
  for (let i = 0; i < w.length; i++) {
    sum += w[i].v;
    while (w[head].t < w[i].t - 1) sum -= w[head++].v;
    if (w[i].t - w[0].t < 1) continue;
    const avg = sum / (i - head + 1);
    if (avg < slo) slo = avg;
    if (avg > shi) shi = avg;
  }
  const slow = shi >= slo ? shi - slo : 0;

  return { raw: hi - lo, detrended, slow, reversals: turns / seconds, ripple, mean: mv, n: w.length };
}

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
