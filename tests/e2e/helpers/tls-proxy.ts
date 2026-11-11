import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';

export interface TlsProxyHandle {
    readonly port: number;
    readonly url: string;
    stop: () => Promise<void>;
}

function generateEphemeralSelfSignedCert(): { key: string; cert: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_tls_'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    try {
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'ec',
                '-pkeyopt',
                'ec_paramgen_curve:prime256v1',
                '-nodes',
                '-days',
                '1',
                '-subj',
                '/CN=localhost',
                '-addext',
                'subjectAltName=DNS:localhost,IP:127.0.0.1',
                '-keyout',
                keyPath,
                '-out',
                certPath,
            ],
            { stdio: 'ignore' }
        );
        return {
            key: fs.readFileSync(keyPath, 'utf8'),
            cert: fs.readFileSync(certPath, 'utf8'),
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Local TLS-terminating HTTP + WebSocket (`wss://`) reverse proxy forwarding to
 * `http://127.0.0.1:${targetPort}` (models Nginx/Caddy in front of the container).
 */
export function startTlsReverseProxy(
    targetPort: number
): Promise<TlsProxyHandle> {
    const { key, cert } = generateEphemeralSelfSignedCert();
    const sockets = new Set<Duplex>();

    const server = https.createServer({ key, cert }, (clientReq, clientRes) => {
        const upstreamReq = http.request(
            {
                hostname: '127.0.0.1',
                port: targetPort,
                method: clientReq.method,
                path: clientReq.url,
                headers: {
                    ...clientReq.headers,
                    'x-forwarded-proto': 'https',
                    'x-forwarded-host': clientReq.headers.host ?? 'localhost',
                },
            },
            (upstreamRes) => {
                clientRes.writeHead(
                    upstreamRes.statusCode ?? 502,
                    upstreamRes.headers
                );
                upstreamRes.pipe(clientRes);
            }
        );
        upstreamReq.on('error', () => {
            if (!clientRes.headersSent) {
                clientRes.writeHead(502);
            }
            clientRes.end();
        });
        clientReq.pipe(upstreamReq);
    });

    server.on('connection', (sock) => {
        sockets.add(sock);
        sock.once('close', () => sockets.delete(sock));
    });

    server.on('upgrade', (req, clientSocket, head) => {
        sockets.add(clientSocket);
        clientSocket.once('close', () => sockets.delete(clientSocket));

        const upstream = net.connect(targetPort, '127.0.0.1', () => {
            const lines = [`GET ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            lines.push('X-Forwarded-Proto: https');
            lines.push('', '');
            upstream.write(lines.join('\r\n'));
            if (head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });

        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as net.AddressInfo;
            resolve({
                port: addr.port,
                url: `https://localhost:${addr.port}`,
                stop: () =>
                    new Promise<void>((res) => {
                        for (const sock of sockets) {
                            sock.destroy();
                        }
                        server.close(() => res());
                    }),
            });
        });
    });
}
