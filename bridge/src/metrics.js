// Pulls the few values Desk Puppy uses out of a decoded SmartSpectra Metrics
// message. Kept free of SDK imports so it can be unit-tested.
//
// Shapes (from the SDK's bundled type declarations, v3.5.0):
//   metrics.breathing.upperTrace : Measurement[]               chest movement trace
//   metrics.breathing.rate       : MeasurementWithConfidence[] breaths per minute
//   metrics.cardio.pulseRate     : MeasurementWithConfidence[] beats per minute
//   Measurement = { value, stable, timestamp (microseconds since epoch) }

/** Microsecond timestamp (number or protobuf Long) -> seconds, or NaN. */
export function toSeconds(ts) {
  if (ts === null || ts === undefined) return NaN;
  const n = typeof ts === 'object' && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts);
  return n > 0 ? n / 1e6 : NaN;
}

function latestRate(list, loose) {
  if (!Array.isArray(list)) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && Number.isFinite(m.value) && m.value > 0 && (loose || m.stable)) return m.value;
  }
  return undefined;
}

/**
 * @param metrics decoded Metrics message
 * @param cursor  { traceT } remembered between calls so repeated samples are skipped
 * @param options.loose also accept rates the SDK has not marked stable
 * @returns {{ trace: {t:number, v:number}[], pulse?: number, breathing?: number }}
 *          trace entries have t = NaN when the SDK supplied no timestamp
 */
export function extractMetrics(metrics, cursor, { loose = false } = {}) {
  const out = { trace: [], pulse: undefined, breathing: undefined };
  if (!metrics || typeof metrics !== 'object') return out;

  const upper = metrics.breathing?.upperTrace;
  if (Array.isArray(upper)) {
    let untimed = null;
    for (const s of upper) {
      if (!s || !Number.isFinite(s.value)) continue;
      const t = toSeconds(s.timestamp);
      if (!Number.isFinite(t)) {
        untimed = s;
        continue;
      }
      if (t <= cursor.traceT) continue; // already seen in an earlier packet
      cursor.traceT = t;
      out.trace.push({ t, v: s.value });
    }
    if (out.trace.length === 0 && untimed) out.trace.push({ t: NaN, v: untimed.value });
  }

  out.breathing = latestRate(metrics.breathing?.rate, loose);
  out.pulse = latestRate(metrics.cardio?.pulseRate, loose);
  return out;
}
