// ── Compile-time connection between named index constants and tuple types ─────
//
// Builds a tuple type `[Schema[0], Schema[1], ...]` directly from an object
// type keyed by numeric index constants (`0 as const`, `1 as const`, ...).
// If an index is skipped (e.g. `0, 2` with `1` missing), `TupleSchema` forces
// the non-contiguous keys to `never`, producing a compile-time type error at
// the schema declaration site.

type ContiguousIndices<
    Schema extends Record<number, unknown>,
    Acc extends unknown[] = [],
    Seen extends number = never,
> = Acc['length'] extends keyof Schema
    ? ContiguousIndices<Schema, [...Acc, unknown], Seen | Acc['length']>
    : Seen;

export type TupleSchema<Schema extends Record<number, unknown>> = Record<
    keyof Schema,
    unknown
> &
    Record<Exclude<keyof Schema, ContiguousIndices<Schema>>, never>;

type BuildTuple<
    Schema extends Record<number, unknown>,
    Acc extends unknown[] = [],
> = Acc['length'] extends keyof Schema
    ? BuildTuple<Schema, [...Acc, Schema[Acc['length']]]>
    : Acc;

export type TupleOf<Schema extends TupleSchema<Schema>> = BuildTuple<Schema>;

export type ReadonlyTupleOf<Schema extends TupleSchema<Schema>> = readonly [
    ...BuildTuple<Schema>,
];
