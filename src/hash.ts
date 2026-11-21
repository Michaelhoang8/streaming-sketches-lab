import { createHash } from 'node:crypto';
export const MAX_TOTAL = 0xffffffff;
export const MAX_KEY_BYTES = 256;
export const HLL_HASH = 'sha256-64-hll-v1';
export const CMS_HASH = 'sha256-64-row-v1';
export function integer(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) throw new Error(`Invalid ${label}`);
}
export function keyBytes(key: string): Buffer {
  if (typeof key !== 'string') throw new Error('Key must be a string');
  const bytes = Buffer.from(key, 'utf8');
  if (bytes.length > MAX_KEY_BYTES || bytes.toString('utf8') !== key) throw new Error('Key must be valid UTF-8 and at most 256 bytes');
  return bytes;
}
export function seededHash64(bytes: Uint8Array, seed: number, domain: 'hll' | 'cms', row = 0): bigint {
  const context = Buffer.alloc(8);
  context.writeUInt32BE(seed, 0); context.writeUInt32BE(row, 4);
  return createHash('sha256').update(domain === 'hll' ? 'sketch-hll-v1\0' : 'sketch-cms-v1\0')
    .update(context).update(bytes).digest().readBigUInt64BE(0);
}
export function bucketRank(hash: bigint, p: number): { bucket: number; rank: number } {
  integer(p, 4, 12, 'HLL precision');
  if (hash < 0n || hash > 0xffffffffffffffffn) throw new Error('Hash must be an unsigned 64-bit integer');
  const remaining = 64 - p;
  const suffix = hash & ((1n << BigInt(remaining)) - 1n);
  return { bucket: Number(hash >> BigInt(remaining)), rank: suffix === 0n ? remaining + 1 : remaining - suffix.toString(2).length + 1 };
}
