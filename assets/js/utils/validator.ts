const FIELD_KEY = 0 as const;
const FIRST_STEP = 1 as const;

export const isString = (val: unknown): string | undefined =>
    typeof val === 'string' ? val : undefined;

export const isNumber = (val: unknown): number | undefined =>
    typeof val === 'number' && !Number.isNaN(val) ? val : undefined;

export const isBoolean = (val: unknown): boolean | undefined =>
    typeof val === 'boolean' ? val : undefined;

export const isFunction = <T extends Function = Function>(
    val: unknown
): OmitThisParameter<T> | undefined =>
    typeof val === 'function' ? (val as OmitThisParameter<T>) : undefined;

export const isArray = (val: unknown): readonly unknown[] | undefined =>
    Array.isArray(val) ? val : undefined;

export const isObject = (val: unknown): Record<string, unknown> | undefined =>
    typeof val === 'object' && val !== null && !Array.isArray(val)
        ? (val as Record<string, unknown>)
        : undefined;

export const trim = (val: string): string | undefined => {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const nullable = <T>(val: T | undefined | null): T | null => val ?? null;

type ValidatorStep = ((v: any) => any) | readonly FieldRule[];

export type FieldRule =
    | readonly [key: string, s1: ValidatorStep]
    | readonly [key: string, s1: ValidatorStep, s2: ValidatorStep]
    | readonly [
          key: string,
          s1: ValidatorStep,
          s2: ValidatorStep,
          s3: ValidatorStep,
      ];

type StepOutput<S> = S extends (v: any) => infer R
    ? R
    : S extends readonly FieldRule[]
      ? InferObjectTuple<S> | undefined
      : unknown;

type ApplyStep<Prev, S> = S extends typeof nullable
    ? Exclude<Prev, undefined> | null
    : Exclude<StepOutput<S>, undefined> | Extract<Prev, null>;

type InferField<F> = F extends readonly [string, infer S1]
    ? Exclude<StepOutput<S1>, undefined>
    : F extends readonly [string, infer S1, infer S2]
      ? ApplyStep<StepOutput<S1>, S2>
      : F extends readonly [string, infer S1, infer S2, infer S3]
        ? ApplyStep<ApplyStep<StepOutput<S1>, S2>, S3>
        : unknown;

export type InferObjectTuple<Fields extends readonly FieldRule[]> = {
    readonly [K in keyof Fields]: InferField<Fields[K]>;
};

export const objectStruct = <const Fields extends readonly FieldRule[]>(
    ...fields: Fields
): Fields => fields;

const runStep = (current: unknown, step: ValidatorStep): unknown => {
    if (step === nullable) {
        return nullable(current);
    }
    if (current === undefined || current === null) {
        return undefined;
    }
    if (typeof step === 'function') {
        return step(current);
    }
    return applyObjectStruct(current, step);
};

const applyObjectStruct = (
    val: unknown,
    fields: readonly FieldRule[]
): readonly unknown[] | undefined => {
    const record = isObject(val);
    if (!record) return undefined;
    const out: unknown[] = [];
    for (const rule of fields) {
        const raw = record[rule[FIELD_KEY]];
        let current: unknown =
            typeof raw === 'function' ? raw.bind(record) : raw;
        for (let i = FIRST_STEP; i < rule.length; i++) {
            current = runStep(current, rule[i] as ValidatorStep);
        }
        if (current === undefined) return undefined;
        out.push(current);
    }
    return out;
};

export function validate<const Fields extends readonly FieldRule[]>(
    val: unknown,
    schema: Fields
): InferObjectTuple<Fields> | undefined;
export function validate<A>(
    val: unknown,
    s1: (v: unknown) => A | undefined
): A | undefined;
export function validate<A, B>(
    val: unknown,
    s1: (v: unknown) => A | undefined,
    s2: (v: A) => B | undefined
): B | undefined;
export function validate<A, B, C>(
    val: unknown,
    s1: (v: unknown) => A | undefined,
    s2: (v: A) => B | undefined,
    s3: (v: B) => C | undefined
): C | undefined;
export function validate(val: unknown, ...steps: ValidatorStep[]): unknown {
    let current = val;
    for (const step of steps) {
        current = runStep(current, step);
        if (current === undefined) return undefined;
    }
    return current;
}
