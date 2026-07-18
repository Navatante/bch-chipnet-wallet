import tls from 'node:tls';

/**
 * Cliente mínimo para servidores Fulcrum/Electrum (protocolo Electrum-Cash).
 *
 * Habla JSON-RPC 2.0 delimitado por saltos de línea sobre TLS. Los servidores
 * Fulcrum usan certificados autofirmados, por eso `rejectUnauthorized: false`.
 *
 * Solo implementa los métodos que la wallet necesita. Fulcrum acepta
 * direcciones CashAddr directamente en los métodos `blockchain.address.*`,
 * así que no hace falta calcular el scripthash a mano.
 */
export interface Utxo {
    tx_hash: string;
    tx_pos: number;
    height: number;
    value: number; // en satoshis
}

export interface Balance {
    confirmed: number; // satoshis
    unconfirmed: number; // satoshis
}

export class ElectrumClient {
    private socket: tls.TLSSocket | null = null;
    private buffer = '';
    private nextId = 1;
    private readonly host: string;
    private readonly port: number;
    private readonly pending = new Map<
        number,
        { resolve: (v: any) => void; reject: (e: Error) => void }
    >();

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = tls.connect(
                { host: this.host, port: this.port, rejectUnauthorized: false },
                () => resolve(),
            );
            this.socket.setEncoding('utf8');
            this.socket.on('data', (chunk: string) => this.onData(chunk));
            this.socket.on('error', (err) => {
                reject(err);
                for (const { reject: rj } of this.pending.values()) rj(err);
                this.pending.clear();
            });
            this.socket.on('close', () => {
                const err = new Error('connection closed by the server');
                for (const { reject: rj } of this.pending.values()) rj(err);
                this.pending.clear();
            });
        });
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line === '') continue;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            const handler = this.pending.get(msg.id);
            if (!handler) continue;
            this.pending.delete(msg.id);
            if (msg.error) {
                handler.reject(
                    new Error(msg.error?.message ?? JSON.stringify(msg.error)),
                );
            } else {
                handler.resolve(msg.result);
            }
        }
    }

    private call<T = any>(method: string, params: unknown[] = []): Promise<T> {
        if (!this.socket) throw new Error('client not connected');
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket!.write(payload + '\n');
        });
    }

    /** Handshake opcional; algunos servidores lo requieren antes de operar. */
    serverVersion(): Promise<[string, string]> {
        return this.call('server.version', ['bch-wallet-cli', '1.4.1']);
    }

    getBalance(address: string): Promise<Balance> {
        return this.call('blockchain.address.get_balance', [address]);
    }

    listUnspent(address: string): Promise<Utxo[]> {
        return this.call('blockchain.address.listunspent', [address]);
    }

    getHistory(address: string): Promise<{ tx_hash: string; height: number }[]> {
        return this.call('blockchain.address.get_history', [address]);
    }

    broadcast(rawTxHex: string): Promise<string> {
        return this.call('blockchain.transaction.broadcast', [rawTxHex]);
    }

    close(): void {
        this.socket?.end();
        this.socket = null;
    }
}
