import * as http from 'http';
import * as net from 'net';

export type MockTxStatus = 'confirmed' | 'pending' | 'reverted' | 'unknown';

export interface MockTxRecord {
    hash: string;
    from: string;
    to: string;
    value: string;
    status: MockTxStatus;
}

export interface MockRpcHandle {
    port: number;
    url: string;
    stop: () => Promise<void>;
}

interface JsonRpcReq {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown[];
}

export async function startMockEthRpcServer(
    initialChainIdHex = '0x1'
): Promise<MockRpcHandle> {
    let chainIdHex = initialChainIdHex;
    let failNextRpc = false;
    const txs = new Map<string, MockTxRecord>();

    const handleRpcCall = (req: JsonRpcReq) => {
        const id = req.id ?? 1;
        if (failNextRpc) {
            return {
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32000,
                    message: 'Simulated upstream RPC error',
                },
            };
        }
        switch (req.method) {
            case 'eth_chainId':
                return { jsonrpc: '2.0', id, result: chainIdHex };
            case 'eth_getTransactionByHash': {
                const hash = String(req.params?.[0] ?? '').toLowerCase();
                const rec = txs.get(hash);
                if (!rec || rec.status === 'unknown') {
                    return { jsonrpc: '2.0', id, result: null };
                }
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        hash: rec.hash,
                        from: rec.from,
                        to: rec.to,
                        value: rec.value,
                    },
                };
            }
            case 'eth_getTransactionReceipt': {
                const hash = String(req.params?.[0] ?? '').toLowerCase();
                const rec = txs.get(hash);
                if (
                    !rec ||
                    rec.status === 'unknown' ||
                    rec.status === 'pending'
                ) {
                    return { jsonrpc: '2.0', id, result: null };
                }
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        status: rec.status === 'confirmed' ? '0x1' : '0x0',
                    },
                };
            }
            default:
                return {
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${req.method}`,
                    },
                };
        }
    };

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (req.url === '/__mock/tx' && req.method === 'POST') {
                const body = JSON.parse(raw) as MockTxRecord;
                const normHash = body.hash.toLowerCase();
                txs.set(normHash, { ...body, hash: normHash });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (req.url === '/__mock/config' && req.method === 'POST') {
                const body = JSON.parse(raw) as {
                    chainIdHex?: string;
                    failNextRpc?: boolean;
                };
                if (body.chainIdHex !== undefined) {
                    chainIdHex = body.chainIdHex;
                }
                if (body.failNextRpc !== undefined) {
                    failNextRpc = body.failNextRpc;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            try {
                const parsed = JSON.parse(raw);
                const wasFailing = failNextRpc;
                const responseBody = Array.isArray(parsed)
                    ? parsed.map(handleRpcCall)
                    : handleRpcCall(parsed);
                if (wasFailing) failNextRpc = false;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responseBody));
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as net.AddressInfo).port;

    return {
        port,
        url: `http://127.0.0.1:${port}`,
        stop: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
            }),
    };
}

export async function registerMockRpcTx(
    rpcUrl: string,
    record: MockTxRecord
): Promise<void> {
    const res = await fetch(`${rpcUrl}/__mock/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
    });
    if (!res.ok) {
        throw new Error(`Failed to register mock tx: ${res.status}`);
    }
}

export async function setMockRpcConfig(
    rpcUrl: string,
    cfg: { chainIdHex?: string; failNextRpc?: boolean }
): Promise<void> {
    const res = await fetch(`${rpcUrl}/__mock/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
    });
    if (!res.ok) {
        throw new Error(`Failed to update mock RPC config: ${res.status}`);
    }
}
