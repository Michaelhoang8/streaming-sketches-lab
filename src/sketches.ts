import { integer, keyBytes, seededHash64, bucketRank, MAX_TOTAL, HLL_HASH, CMS_HASH } from './hash.ts';
export type HllState = { version: 1; algorithm: 'hll'; hash: typeof HLL_HASH; seed: number; p: number; registers: string };
export type CmsState = { version: 1; algorithm: 'count-min'; hash: typeof CMS_HASH; seed: number; width: number; depth: number; total: number; counters: string };
export type SketchState = HllState | CmsState;

export class HyperLogLog {
  readonly #p: number;
  readonly #seed: number;
  #registers: Uint8Array;
  constructor(p = 8, seed = 0) {
    integer(p, 4, 12, 'HLL precision'); integer(seed, 0, MAX_TOTAL, 'hash seed');
    this.#p = p; this.#seed = seed; this.#registers = new Uint8Array(2 ** p);
  }
  get p(): number { return this.#p; }
  get seed(): number { return this.#seed; }
  get payloadBytes(): number { return this.#registers.byteLength; }
  add(key: string): void {
    const { bucket, rank } = bucketRank(seededHash64(keyBytes(key), this.seed, 'hll'), this.p);
    this.#registers[bucket] = Math.max(this.#registers[bucket], rank);
  }
  estimate(): { estimate: number; raw: number; zeroRegisters: number; method: 'linear-counting' | 'raw-hll' } {
    const m = this.#registers.length;
    const alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m);
    let reciprocalSum = 0; let zeroRegisters = 0;
    for (const value of this.#registers) { reciprocalSum += 2 ** -value; if (value === 0) zeroRegisters += 1; }
    const raw = alpha * m * m / reciprocalSum;
    const corrected = raw <= 2.5 * m && zeroRegisters > 0;
    return { estimate: corrected ? m * Math.log(m / zeroRegisters) : raw, raw, zeroRegisters, method: corrected ? 'linear-counting' : 'raw-hll' };
  }
  merge(other: HyperLogLog): this {
    if (!(other instanceof HyperLogLog) || other.p !== this.p || other.seed !== this.seed) throw new Error('Incompatible HLL configuration');
    for (let i = 0; i < this.#registers.length; i += 1) this.#registers[i] = Math.max(this.#registers[i], other.#registers[i]);
    return this;
  }
  snapshot(): HllState {
    return { version: 1, algorithm: 'hll', hash: HLL_HASH, seed: this.seed, p: this.p, registers: Buffer.from(this.#registers).toString('base64') };
  }
  static restore(state: HllState): HyperLogLog {
    const checked = validateState(state);
    if (checked.algorithm !== 'hll') throw new Error('Expected HLL state');
    const sketch = new HyperLogLog(checked.p, checked.seed);
    sketch.#registers.set(Buffer.from(checked.registers, 'base64'));
    return sketch;
  }
}

export class CountMinSketch {
  readonly #width: number;
  readonly #depth: number;
  readonly #seed: number;
  #counters: Uint32Array;
  #total = 0;
  constructor(width = 256, depth = 4, seed = 0) {
    integer(width, 16, 4096, 'Count-Min width');
    if ((width & (width - 1)) !== 0) throw new Error('Count-Min width must be a power of two');
    integer(depth, 2, 8, 'Count-Min depth'); integer(seed, 0, MAX_TOTAL, 'hash seed');
    this.#width = width; this.#depth = depth; this.#seed = seed; this.#counters = new Uint32Array(width * depth);
  }
  get width(): number { return this.#width; }
  get depth(): number { return this.#depth; }
  get seed(): number { return this.#seed; }
  get payloadBytes(): number { return this.#counters.byteLength; }
  get total(): number { return this.#total; }
  #positions(bytes: Uint8Array): number[] {
    return Array.from({ length: this.depth }, (_, row) => row * this.width + Number(seededHash64(bytes, this.seed, 'cms', row) % BigInt(this.width)));
  }
  add(key: string, weight = 1): void {
    integer(weight, 0, MAX_TOTAL, 'nonnegative update weight');
    const bytes = keyBytes(key);
    if (this.#total + weight > MAX_TOTAL) throw new Error('Count-Min total overflow');
    const positions = this.#positions(bytes);
    for (const index of positions) if (this.#counters[index] + weight > MAX_TOTAL) throw new Error('Count-Min counter overflow');
    for (const index of positions) this.#counters[index] += weight;
    this.#total += weight;
  }
  estimate(key: string): number {
    let estimate = MAX_TOTAL;
    for (const index of this.#positions(keyBytes(key))) estimate = Math.min(estimate, this.#counters[index]);
    return estimate;
  }
  merge(other: CountMinSketch): this {
    if (!(other instanceof CountMinSketch) || other.width !== this.width || other.depth !== this.depth || other.seed !== this.seed) throw new Error('Incompatible Count-Min configuration');
    if (this.#total + other.#total > MAX_TOTAL) throw new Error('Count-Min merge total overflow');
    for (let i = 0; i < this.#counters.length; i += 1) if (this.#counters[i] + other.#counters[i] > MAX_TOTAL) throw new Error('Count-Min merge counter overflow');
    for (let i = 0; i < this.#counters.length; i += 1) this.#counters[i] += other.#counters[i];
    this.#total += other.#total;
    return this;
  }
  snapshot(): CmsState {
    const bytes = Buffer.alloc(this.#counters.byteLength);
    this.#counters.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
    return { version: 1, algorithm: 'count-min', hash: CMS_HASH, seed: this.seed, width: this.width,
      depth: this.depth, total: this.#total, counters: bytes.toString('base64') };
  }
  static restore(state: CmsState): CountMinSketch {
    const checked = validateState(state);
    if (checked.algorithm !== 'count-min') throw new Error('Expected Count-Min state');
    const sketch = new CountMinSketch(checked.width, checked.depth, checked.seed);
    const bytes = Buffer.from(checked.counters, 'base64');
    for (let index = 0; index < sketch.#counters.length; index += 1) sketch.#counters[index] = bytes.readUInt32LE(index * 4);
    sketch.#total = checked.total;
    return sketch;
  }
}

function base64(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) throw new Error('Incorrect state payload length');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) throw new Error('Noncanonical base64 payload');
  return bytes;
}

export function validateState(input: unknown): SketchState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Sketch state must be an object');
  const state = input as Record<string, unknown>;
  if (state.version !== 1) throw new Error('Unsupported sketch state version');
  integer(state.seed, 0, MAX_TOTAL, 'hash seed');
  const exactKeys = (expected: string[]) => {
    if (Object.keys(state).sort().join(',') !== expected.sort().join(',')) throw new Error('Unexpected or missing sketch fields');
  };
  if (state.algorithm === 'hll') {
    exactKeys(['version', 'algorithm', 'hash', 'seed', 'p', 'registers']);
    if (state.hash !== HLL_HASH) throw new Error('Unknown HLL hash configuration');
    integer(state.p, 4, 12, 'HLL precision');
    const bytes = base64(state.registers, 2 ** state.p);
    if (bytes.some(rank => rank > 65 - (state.p as number))) throw new Error('HLL register exceeds 64-bit rank limit');
    return { version: 1, algorithm: 'hll', hash: HLL_HASH, seed: state.seed, p: state.p, registers: bytes.toString('base64') };
  }
  if (state.algorithm === 'count-min') {
    exactKeys(['version', 'algorithm', 'hash', 'seed', 'width', 'depth', 'total', 'counters']);
    if (state.hash !== CMS_HASH) throw new Error('Unknown Count-Min hash configuration');
    integer(state.width, 16, 4096, 'Count-Min width');
    if ((state.width & (state.width - 1)) !== 0) throw new Error('Count-Min width must be a power of two');
    integer(state.depth, 2, 8, 'Count-Min depth'); integer(state.total, 0, MAX_TOTAL, 'Count-Min total');
    const bytes = base64(state.counters, state.width * state.depth * 4);
    for (let row = 0; row < state.depth; row += 1) {
      let rowSum = 0;
      for (let column = 0; column < state.width; column += 1) rowSum += bytes.readUInt32LE((row * state.width + column) * 4);
      if (rowSum !== state.total) throw new Error('Count-Min row sum differs from total');
    }
    return { version: 1, algorithm: 'count-min', hash: CMS_HASH, seed: state.seed, width: state.width,
      depth: state.depth, total: state.total, counters: bytes.toString('base64') };
  }
  throw new Error('Unknown sketch algorithm');
}

export const MAX_STATE_BYTES = 200000;
export function encodeState(input: SketchState): string { return JSON.stringify(validateState(input)); }
export function decodeState(input: Uint8Array | string): SketchState {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error('Sketch document exceeds byte limit');
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const state = validateState(JSON.parse(text) as unknown);
  if (encodeState(state) !== text) throw new Error('Noncanonical sketch document');
  return state;
}
