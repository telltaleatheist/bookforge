/**
 * THE PLACES PYTHON AND JAVASCRIPT DISAGREE, in one file, each pinned to vectors captured
 * from Python (`tools/fixtures/narrator-py-compat.json`).
 *
 * The narrator's files were written by Python and every reader of them was measured
 * against those bytes, so the port has to produce the same bytes. Each function here is a
 * real difference; nothing else in `electron/narrator/` may paper over one on its own.
 */

/** A value Python holds as a float, so it prints as `0.0` where JavaScript would print `0`. */
export class PyFloat {
  constructor(readonly value: number) {}
}

export const pyFloat = (value: number): PyFloat => new PyFloat(value);

/** `repr(float)`: shortest round-trip digits, as JavaScript's, with Python's exponent rules. */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (Object.is(value, -0)) return '-0.0';
  if (value === 0) return '0.0';
  const [digits, exponentText] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  // Python switches to an exponent below 1e-4 and at 1e16; JavaScript at 1e-6 and 1e21.
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent < 0 ? '-' : '+';
    return `${digits}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  const shortest = shortestFixed(value, digits, exponent);
  return shortest.includes('.') ? shortest : `${shortest}.0`;
}

/** The fixed-point spelling of `digits × 10^exponent`, without floating-point arithmetic. */
function shortestFixed(value: number, digits: string, exponent: number): string {
  const negative = digits.startsWith('-');
  const bare = (negative ? digits.slice(1) : digits).replace('.', '');
  const sign = negative || value < 0 ? '-' : '';
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${bare}`;
  if (bare.length <= exponent + 1) return `${sign}${bare}${'0'.repeat(exponent + 1 - bare.length)}`;
  return `${sign}${bare.slice(0, exponent + 1)}.${bare.slice(exponent + 1)}`;
}

/**
 * Python's whitespace, for `\s`, `str.isspace` and `str.strip`. JavaScript's leaves out U+001C-1F
 * and U+0085, and adds U+FEFF, which Python treats as a character.
 */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** The `regex` module's `\s`, which the Python's text layer used: the same, less U+001C-1F. */
export const PY_REGEX_SPACE = PY_SPACE.replace('\\x1c-\\x1f', '');
const PY_SPACE_ONE = new RegExp(`^[${PY_SPACE}]$`);
const PY_SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'g');
const PY_SPACE_EDGES = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');

export const isPySpace = (ch: string): boolean => PY_SPACE_ONE.test(ch);

export const pyStrip = (text: string): string => text.replace(PY_SPACE_EDGES, '');

/** `re.sub(r'\s+', ' ', text)`. */
export const pyCollapseSpace = (text: string, replacement = ' '): string => text.replace(PY_SPACE_RUN, replacement);

const PY_REGEX_SPACE_RUN = new RegExp(`[${PY_REGEX_SPACE}]+`, 'g');

/** The same, as the `regex` module spells it. */
export const pyRegexCollapseSpace = (text: string): string => text.replace(PY_REGEX_SPACE_RUN, ' ');

function jsonString(text: string): string {
  return JSON.stringify(text);
}

/**
 * `json.dumps(value, indent=2, ensure_ascii=False)`. A plain number prints as JavaScript
 * would, which is right for a Python int; a Python float must arrive as a {@link PyFloat},
 * because a parsed `0.0` and a parsed `0` are the same thing here and not there.
 */
export function pyJsonDumps(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  }
  if (typeof value === 'string') return jsonString(value);
  const inner = '  '.repeat(depth + 1);
  const outer = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => inner + pyJsonDumps(item, depth + 1)).join(',\n')}\n${outer}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([key, item]) => `${inner}${jsonString(key)}: ${pyJsonDumps(item, depth + 1)}`).join(',\n')}\n${outer}}`;
}

/** `json.dumps`'s default escaping, applied to {@link pyJsonDumps}: past ASCII and DEL, one UTF-16 unit at a time. */
export const pyJsonDumpsAscii = (value: unknown): string => pyJsonDumps(value)
  .replace(/[^\n -~]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** `round(value, digits)`: correctly rounded on the exact binary value, which `toFixed` is not. */
export const pyRound = (value: number, digits: number): number => Number(pyFixed(value, digits));

/** `repr()` for what the refusal sentences quote: a string, a number, a bool, None. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
}

/** `round(value, 1)`: the exact value to one decimal, an exact tie going to the even digit. */
export function pyRound1(value: number): number {
  const scaled = value * 10;
  // `toFixed` rounds the exact binary value, and only an exact tie can differ from Python.
  if (Math.abs(scaled % 1) === 0.5 && scaled / 10 === value) {
    const floor = Math.floor(scaled);
    return (floor % 2 === 0 ? floor : floor + 1) / 10;
  }
  return Number(value.toFixed(1));
}

/** `round(value)`: to an integer, an exact tie going to the even side. */
export function pyRoundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * `f'{value:.{digits}f}'`. Python rounds the exact binary value, an exact tie going to the even
 * digit; `toFixed` takes the larger on a tie. Ties are real: 25,500 samples at 24 kHz is exactly
 * 1.0625 s, `1.062` in Python and `1.063` by `toFixed`. So this works in exact integers.
 */
export function pyFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = rawExponent === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (rawExponent === 0 ? 1 : rawExponent) - 1075;
  const scaled = mantissa * 10n ** BigInt(digits);
  let rounded: bigint;
  if (exponent >= 0) {
    rounded = scaled << BigInt(exponent);
  } else {
    const shift = BigInt(-exponent);
    const whole = scaled >> shift;
    const rest = scaled - (whole << shift);
    const half = 1n << (shift - 1n);
    rounded = rest > half || (rest === half && (whole & 1n) === 1n) ? whole + 1n : whole;
  }
  const text = rounded.toString().padStart(digits + 1, '0');
  const body = digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  return negative ? `-${body}` : body;
}

/** `a // b` on floats: built on the remainder, as CPython does, not on `Math.floor(a / b)`. */
export function pyFloorDiv(a: number, b: number): number {
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && (b < 0) !== (mod < 0)) div -= 1;
  const floor = Math.floor(div);
  return div - floor > 0.5 ? floor + 1 : floor;
}

/** `int(text)` for what a JSON key can be: signs, surrounding space, digit underscores. */
export function pyInt(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(trimmed)) return null;
  return Number(trimmed.replace(/_/g, ''));
}

/** Python's truth: an empty string, list, object, 0 and None are all false. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}
