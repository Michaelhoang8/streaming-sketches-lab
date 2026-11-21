# Sketch and state specification

## Key and hash contract

Keys are JavaScript strings whose UTF-8 byte representation round-trips exactly and has length at most 256. Empty strings are allowed. No Unicode normalization or case folding occurs. Unpaired surrogates are rejected. The seeded hash input is:

`domain || seed_u32_big_endian || row_u32_big_endian || key_utf8`

The domain is exactly `sketch-hll-v1` followed by one zero byte for HLL, or `sketch-cms-v1` followed by one zero byte for Count-Min. SHA-256 is computed over that sequence; the first eight bytes are read as an unsigned big-endian 64-bit integer. HLL uses row 0; Count-Min uses row indexes 0 through depth minus one. Seeds are bounded uint32 values.

The domain separation avoids accidental algorithm/row input aliasing; it is not a proof of universal hashing or statistical independence. Repeated seeds and keys give identical hash words.

## HLL

Precision is an integer 4–12, with `m = 2^p` registers in a private `Uint8Array`.

For an unsigned 64-bit word, the high `p` bits identify the bucket. The remaining `q = 64 - p` bits determine the rank: one plus the number of leading zeroes, or `q + 1` if all suffix bits are zero. Register update takes the maximum of old rank and new rank. Unobserved registers are zero.

Examples at `p = 4`:

| Word | Bucket | Rank |
| --- | ---: | ---: |
| `0000000000000000` | 0 | 61 |
| `a800000000000000` | 10 | 1 |
| `a100000000000000` | 10 | 4 |
| `a000000000000001` | 10 | 60 |

Let `S = sum(2^-M[j])`. The raw estimate is `alpha(m) × m² / S`, with `alpha(16)=0.673`, `alpha(32)=0.697`, `alpha(64)=0.709`, and `alpha(m)=0.7213/(1+1.079/m)` for larger supported arrays. If raw estimate is at most `2.5m` and the number of zero registers `V` is positive, the returned estimate is `m × ln(m/V)`. Otherwise it is the raw estimate. The result also exposes the raw value, empty-register count and selected correction mode.

There is no large-range correction, sparse mode, bias table or deletion. Supported storage bounds do not imply that accuracy near 64-bit hash saturation has been validated. Merge takes register-wise maxima and requires the same precision and seed. It is idempotent and represents distinct-set union, including overlapping streams.

## Count-Min

Width is a power of two in 16–4,096; depth is an integer 2–8. State is a private row-major `Uint32Array`. Row `r` uses its own domain-separated hash context and selects column `hash64 mod width`.

An update weight is an integer 0 through `2^32 - 1`. It is added to the selected counter in every row and to the total. A query returns the minimum selected counter. Total represented weight may never exceed `2^32 - 1`. Updates and merges check all relevant sums before mutation and throw if any would overflow.

Merge sums corresponding counters and totals, requiring identical width, depth and seed. Merging a sketch with itself doubles the represented multiset. There is no source identity tracking or overlap detection. A zero-weight update does not change state; negative and fractional weights are invalid.

For a valid state built from nonnegative updates, each row contains a key's true count plus other keys that collide with it. This yields the structural no-underestimate property. It does not establish a probabilistic additive-error bound for the configured hash family.

## Canonical snapshot documents

Snapshots use UTF-8 JSON without a BOM, fixed key order, no interior whitespace and at most one terminal LF. The whole document is bounded to 200,000 bytes. Numeric values have canonical JSON integer spelling; negative zero and alternate spellings fail the textual round-trip check. Duplicate keys and extra fields are rejected.

HLL field order:

```text
version, algorithm, hash, seed, p, registers
```

`version=1`, `algorithm="hll"`, `hash="sha256-64-hll-v1"`. `registers` is canonical padded base64 of exactly `2^p` bytes. Each byte is at most `65 - p`, reflecting the maximum 64-bit suffix rank.

Count-Min field order:

```text
version, algorithm, hash, seed, width, depth, total, counters
```

`version=1`, `algorithm="count-min"`, `hash="sha256-64-row-v1"`. `counters` is canonical padded base64 of exactly `width × depth × 4` bytes, with each uint32 encoded **little-endian**, in row-major order. Every decoded row must sum exactly to `total`. Given nonnegative uint32 counters, this also prevents a single counter exceeding the total.

Validation constructs a fresh canonical object, serializes it, and requires exact equality with the input after removing at most one LF. Object-based restore also validates fields and payload invariants, then copies bytes into private state. Input objects cannot retain a mutable reference to sketch storage. Configuration is private and exposed only through getters.

The format has no checksum, signature or authentication layer. Structurally valid state can be fabricated. Validation does not prove that a snapshot represents a particular source stream or that reported totals are truthful. Version and hash identifiers are compatibility contracts, not trust assertions.

## Experiment semantics

The stream generator uses the recurrence `state = (1664525 × state + 1013904223) mod 2^32`, then `U = state / 2^32`. The uniform rule is `floor(U × 4096)`; the skewed rule is `floor(U^4 × 4096)`. The repeated stream uses `floor(index / 50) mod 64`. Resulting keys are `key-` plus four decimal digits. Definitions, initial states, exact counts and hashes are in [data/manifest.json](../data/manifest.json).

HLL error divides by exact distinct cardinality. Count-Min overcount is estimate minus exact frequency. Mean/p95 present-key statistics weight keys equally; normalized overcount divides by total stream events. Absent positive rate is the fraction of 64 unobserved query keys receiving an estimate greater than zero. It is not a general membership false-positive probability over an unspecified universe.

Twenty fixed hash seeds are repeated over the same streams and configurations. Seed aggregate medians, RMSEs and sample quantiles are descriptive. The raw CSV files preserve all run-level values, and a deterministic query panel preserves individual exact/estimated frequencies. No confidence interval or independent-population assumption is used.
