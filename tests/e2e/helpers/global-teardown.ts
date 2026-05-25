export default async function globalTeardown(): Promise<void> {
    if (typeof global.__SERVER_STOP__ === 'function') {
        await global.__SERVER_STOP__();
        console.log('[e2e] Server stopped');
    }
}
