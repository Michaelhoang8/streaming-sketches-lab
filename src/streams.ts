export type StreamName = 'uniform' | 'power-skewed' | 'repeated';
export type StreamDefinition = { name: StreamName; events: number; keySpace: number; generatorSeed: number; rule: string };
export const definitions: StreamDefinition[] = [
  { name: 'uniform', events: 12000, keySpace: 4096, generatorSeed: 0x10203040, rule: 'floor(U * 4096), U from seeded 32-bit LCG / 2^32' },
  { name: 'power-skewed', events: 12000, keySpace: 4096, generatorSeed: 0x50607080, rule: 'floor(U^4 * 4096); a defined power transform, not a fitted Zipf distribution' },
  { name: 'repeated', events: 12000, keySpace: 64, generatorSeed: 0, rule: 'floor(eventIndex / 50) mod 64; deterministic 50-event blocks' },
];
export function makeStream(definition: StreamDefinition): string[] {
  let randomState = definition.generatorSeed >>> 0;
  return Array.from({ length: definition.events }, (_, index) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    const uniform = randomState / 4294967296;
    const rank = definition.name === 'repeated' ? Math.floor(index / 50) % definition.keySpace
      : Math.floor((definition.name === 'power-skewed' ? uniform ** 4 : uniform) * definition.keySpace);
    return `key-${String(rank).padStart(4, '0')}`;
  });
}
export function exactCounts(stream: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of stream) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}
export function queryPanel(counts: Map<string, number>): string[] {
  const ordered = [...counts.keys()].sort();
  const chosen = new Set<string>();
  for (let i = 0; i < Math.min(64, ordered.length); i += 1) chosen.add(ordered[Math.floor(i * ordered.length / Math.min(64, ordered.length))]);
  for (const [key] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8)) chosen.add(key);
  for (let i = 0; i < 64; i += 1) chosen.add(`absent-${String(i).padStart(4, '0')}`);
  return [...chosen];
}
