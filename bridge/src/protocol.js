// Serial protocol between the PC bridge and the display board.
//
//   V,<pulse bpm>,<breaths per min>,<state>,<chest -100..100>\n
//
// Any field may be "x" when the value is unknown.

export const State = Object.freeze({
  SEARCHING: 0,
  AWAKE: 1,
  SLEEPY: 2,
  HOLD: 3,
  EXCITED: 4,
});

export const STATE_NAMES = Object.freeze(['searching', 'awake', 'sleepy', 'breath held', 'excited']);

export const BAUD_RATE = 115200;
export const HELLO = '?\n';
export const HELLO_REPLY = 'PUPPY 1';

function field(value, digits, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'x';
  const clamped = Math.min(hi, Math.max(lo, value));
  const text = clamped.toFixed(digits);
  // toFixed can produce "-0"; the board parses it fine but it reads oddly in logs.
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

export function formatLine({ pulse, breathing, state, chest }) {
  const s = Number.isInteger(state) && state >= 0 && state <= 4 ? state : State.SEARCHING;
  // The board treats a pulse or breathing rate of 0 as "unknown", so send "x" for those.
  const p = pulse > 0 ? field(pulse, 0, 1, 220) : 'x';
  const b = breathing > 0 ? field(breathing, 1, 0.1, 60) : 'x';
  return `V,${p},${b},${s},${field(chest, 0, -100, 100)}\n`;
}
