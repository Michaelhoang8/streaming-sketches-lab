import { readFileSync, statSync } from 'node:fs';
import { HyperLogLog, CountMinSketch, decodeState, encodeState, MAX_STATE_BYTES } from '../src/sketches.ts';
const help = `Usage: npm run cli -- <command> <arguments>
  hll <stream.txt> <precision> <seed>
  count-min <stream.txt> <width> <depth> <seed>
  estimate <snapshot.json> [key]
  merge <snapshot-a.json> <snapshot-b.json>
Stream files are LF-separated UTF-8 keys with terminal LF. Output snapshots are canonical JSON.
Count-Min merge sums observations; merging overlapping streams double-counts them.`;
const integer = (text: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('Expected an unsigned decimal integer');
  return Number(text);
};
const readState = (file: string) => {
  if (statSync(file).size > MAX_STATE_BYTES) throw new Error('Snapshot exceeds byte limit');
  return decodeState(readFileSync(file));
};
const readStream = (file: string) => {
  if (statSync(file).size > 16 * 1024 * 1024) throw new Error('CLI stream exceeds 16 MiB limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  if (text === '') return [];
  if (!text.endsWith('\n') || text.includes('\r')) throw new Error('Stream requires LF framing and a terminal LF');
  return text.slice(0, -1).split('\n');
};
function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') { console.log(help); return; }
  try {
    if (command === 'hll' && args.length === 3) {
      const sketch = new HyperLogLog(integer(args[1]), integer(args[2]));
      for (const key of readStream(args[0])) sketch.add(key);
      console.log(encodeState(sketch.snapshot()));
    } else if (command === 'count-min' && args.length === 4) {
      const sketch = new CountMinSketch(integer(args[1]), integer(args[2]), integer(args[3]));
      for (const key of readStream(args[0])) sketch.add(key);
      console.log(encodeState(sketch.snapshot()));
    } else if (command === 'estimate' && [1, 2].includes(args.length)) {
      const state = readState(args[0]);
      if (state.algorithm === 'hll' && args.length === 1) console.log(JSON.stringify(HyperLogLog.restore(state).estimate()));
      else if (state.algorithm === 'count-min' && args.length === 2) console.log(JSON.stringify({ key: args[1], estimate: CountMinSketch.restore(state).estimate(args[1]), total: state.total }));
      else throw new Error('HLL estimate takes no key; Count-Min estimate requires a key');
    } else if (command === 'merge' && args.length === 2) {
      const a = readState(args[0]); const b = readState(args[1]);
      if (a.algorithm === 'hll' && b.algorithm === 'hll') console.log(encodeState(HyperLogLog.restore(a).merge(HyperLogLog.restore(b)).snapshot()));
      else if (a.algorithm === 'count-min' && b.algorithm === 'count-min') console.log(encodeState(CountMinSketch.restore(a).merge(CountMinSketch.restore(b)).snapshot()));
      else throw new Error('Cannot merge different sketch algorithms');
    } else throw new Error('Invalid command or arguments; use --help');
  } catch (error) { console.error(`Error: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 2; }
}
main();
