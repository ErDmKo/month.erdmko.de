/**
 * Deterministic test-only Ethereum cryptography (Keccak-256 + secp256k1 EIP-191 personal_sign).
 * Uses only built-in Node.js primitives + BigInt — zero external npm dependencies, never real keys.
 */
import * as crypto from 'crypto';

// ── Keccak-256 (FIPS-202 pre-NIST padding 0x01) ─────────────────────────────

const ROTC = [
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18,
    39, 61, 20, 44,
];
const PILN = [
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14,
    22, 9, 6, 1,
];
const RC: bigint[] = [
    0x0000000000000001n,
    0x0000000000008082n,
    0x800000000000808an,
    0x8000000080008000n,
    0x000000000000808bn,
    0x0000000080000001n,
    0x8000000080008081n,
    0x8000000000008009n,
    0x000000000000008an,
    0x0000000000000088n,
    0x0000000080008009n,
    0x000000008000000an,
    0x000000008000808bn,
    0x800000000000008bn,
    0x8000000000008089n,
    0x8000000000008003n,
    0x8000000000008002n,
    0x8000000000000080n,
    0x000000000000800an,
    0x800000008000000an,
    0x8000000080008081n,
    0x8000000000008080n,
    0x0000000080000001n,
    0x8000000080008008n,
];
const MASK_64 = 0xffffffffffffffffn;

const rotl64 = (x: bigint, n: number): bigint =>
    ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK_64;

function keccakF1600(state: bigint[]): void {
    const bc = new Array<bigint>(5);
    for (let round = 0; round < 24; round++) {
        for (let i = 0; i < 5; i++) {
            bc[i] =
                state[i] ^
                state[i + 5] ^
                state[i + 10] ^
                state[i + 15] ^
                state[i + 20];
        }
        for (let i = 0; i < 5; i++) {
            const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
            for (let j = 0; j < 25; j += 5) {
                state[j + i] = (state[j + i] ^ t) & MASK_64;
            }
        }
        let t = state[1];
        for (let i = 0; i < 24; i++) {
            const j = PILN[i];
            const tmp = state[j];
            state[j] = rotl64(t, ROTC[i]);
            t = tmp;
        }
        for (let j = 0; j < 25; j += 5) {
            for (let i = 0; i < 5; i++) bc[i] = state[j + i];
            for (let i = 0; i < 5; i++) {
                state[j + i] =
                    (state[j + i] ^
                        (~bc[(i + 1) % 5] & bc[(i + 2) % 5] & MASK_64)) &
                    MASK_64;
            }
        }
        state[0] = (state[0] ^ RC[round]) & MASK_64;
    }
}

export function keccak256(input: Buffer | Uint8Array): Buffer {
    const rate = 136; // 1088 bits
    const state = new Array<bigint>(25).fill(0n);
    const padLen = rate - (input.length % rate);
    const padded = Buffer.alloc(input.length + padLen);
    Buffer.from(input).copy(padded);
    padded[input.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;

    for (let offset = 0; offset < padded.length; offset += rate) {
        for (let i = 0; i < 17; i++) {
            state[i] =
                (state[i] ^ padded.readBigUInt64LE(offset + i * 8)) & MASK_64;
        }
        keccakF1600(state);
    }

    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) {
        out.writeBigUInt64LE(state[i], i * 8);
    }
    return out;
}

// ── secp256k1 curve arithmetic (BigInt) ─────────────────────────────────────

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint = P): bigint => ((a % m) + m) % m;

function modInv(a: bigint, m: bigint = P): bigint {
    let [oldR, r] = [mod(a, m), m];
    let [oldS, s] = [1n, 0n];
    while (r !== 0n) {
        const q = oldR / r;
        [oldR, r] = [r, oldR - q * r];
        [oldS, s] = [s, oldS - q * s];
    }
    return mod(oldS, m);
}

function pointAdd(p1: Point, p2: Point): Point {
    if (!p1) return p2;
    if (!p2) return p1;
    if (p1.x === p2.x && p1.y !== p2.y) return null;
    const slope =
        p1.x === p2.x
            ? mod(3n * p1.x * p1.x * modInv(2n * p1.y))
            : mod((p2.y - p1.y) * modInv(p2.x - p1.x));
    const x3 = mod(slope * slope - p1.x - p2.x);
    const y3 = mod(slope * (p1.x - x3) - p1.y);
    return { x: x3, y: y3 };
}

function scalarMul(k: bigint, pt: Point = { x: GX, y: GY }): Point {
    let result: Point = null;
    let addend: Point = pt;
    let scalar = mod(k, N);
    while (scalar > 0n) {
        if (scalar & 1n) result = pointAdd(result, addend);
        addend = pointAdd(addend, addend);
        scalar >>= 1n;
    }
    return result;
}

function parsePrivKeyBigInt(privKeyHex: string): bigint {
    const clean = privKeyHex.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error('Test private key must be 32 hex bytes');
    }
    const d = BigInt(`0x${clean}`);
    if (d <= 0n || d >= N) throw new Error('Out-of-range secp256k1 scalar');
    return d;
}

/** Deterministic test private key from a small integer seed (1, 2, 3, ...). */
export function testPrivateKey(seed: number): string {
    return `0x${seed.toString(16).padStart(64, '0')}`;
}

export function walletAddressFromPrivateKey(privKeyHex: string): string {
    const d = parsePrivKeyBigInt(privKeyHex);
    const pub = scalarMul(d);
    if (!pub) throw new Error('Invalid public key point');
    const uncompressed64 = Buffer.concat([
        Buffer.from(pub.x.toString(16).padStart(64, '0'), 'hex'),
        Buffer.from(pub.y.toString(16).padStart(64, '0'), 'hex'),
    ]);
    const hash = keccak256(uncompressed64);
    return `0x${hash.subarray(12).toString('hex')}`;
}

export function eip191Digest(message: string): Buffer {
    const msgBytes = Buffer.from(message, 'utf8');
    const prefix = Buffer.from(
        `\x19Ethereum Signed Message:\n${msgBytes.length}`,
        'utf8'
    );
    return keccak256(Buffer.concat([prefix, msgBytes]));
}

export function signPersonalMessage(
    privKeyHex: string,
    message: string
): string {
    const d = parsePrivKeyBigInt(privKeyHex);
    const zHash = eip191Digest(message);
    const z = BigInt(`0x${zHash.toString('hex')}`);

    for (let counter = 0; counter < 100; counter++) {
        const kBytes = crypto
            .createHmac(
                'sha256',
                Buffer.from(d.toString(16).padStart(64, '0'), 'hex')
            )
            .update(zHash)
            .update(Buffer.from([counter]))
            .digest();
        const k = mod(BigInt(`0x${kBytes.toString('hex')}`), N);
        if (k === 0n) continue;
        const R = scalarMul(k);
        if (!R) continue;
        const r = R.x % N;
        if (r === 0n) continue;
        let s = mod(modInv(k, N) * (z + r * d), N);
        if (s === 0n) continue;
        let recId = Number(R.y & 1n);
        if (R.x >= N) recId |= 2;
        if (s > N / 2n) {
            s = N - s;
            recId ^= 1;
        }
        const v = 27 + recId;
        return (
            '0x' +
            r.toString(16).padStart(64, '0') +
            s.toString(16).padStart(64, '0') +
            v.toString(16).padStart(2, '0')
        );
    }
    throw new Error('Failed to sign EIP-191 message');
}
