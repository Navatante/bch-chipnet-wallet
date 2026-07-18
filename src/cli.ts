#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ElectrumClient } from './electrum.ts';
import {
    createMnemonic,
    deriveWallet,
    validateMnemonic,
    buildTransaction,
    satsToBch,
    bchToSats,
    DUST_LIMIT,
    type Network,
    type WalletKeys,
} from './wallet.ts';

// --- Configuración -----------------------------------------------------------

const NETWORK: Network = (process.env.BCH_NETWORK as Network) ?? 'chipnet';
const SERVER_HOST = process.env.BCH_SERVER ?? 'chipnet.imaginary.cash';
const SERVER_PORT = Number(process.env.BCH_PORT ?? 50002);
const WALLET_FILE = process.env.BCH_WALLET_FILE
    ? path.resolve(process.env.BCH_WALLET_FILE)
    : path.resolve(process.cwd(), 'wallet.json');

// --- Persistencia (¡mnemónica en claro; solo para chipnet/pruebas!) ----------

interface WalletFile {
    mnemonic: string;
    network: Network;
}

const saveWallet = (mnemonic: string): void => {
    const data: WalletFile = { mnemonic, network: NETWORK };
    fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
};

const loadWallet = (): WalletKeys => {
    if (!fs.existsSync(WALLET_FILE)) {
        throw new Error(
            `no hay wallet en ${WALLET_FILE}. Crea una con "new" o "restore".`,
        );
    }
    const data: WalletFile = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    return deriveWallet(data.mnemonic, data.network ?? NETWORK);
};

// --- Utilidades --------------------------------------------------------------

const withClient = async <T>(
    fn: (client: ElectrumClient) => Promise<T>,
): Promise<T> => {
    const client = new ElectrumClient(SERVER_HOST, SERVER_PORT);
    await client.connect();
    try {
        await client.serverVersion();
        return await fn(client);
    } finally {
        client.close();
    }
};

const confirm = async (question: string): Promise<boolean> => {
    if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`${question} [s/N] `)).trim().toLowerCase();
    rl.close();
    return answer === 's' || answer === 'si' || answer === 'y' || answer === 'yes';
};

const printWalletHeader = (w: WalletKeys): void => {
    console.log(`Red:       ${w.network} (servidor ${SERVER_HOST}:${SERVER_PORT})`);
    console.log(`Ruta:      ${w.derivationPath}`);
    console.log(`Dirección: ${w.address}`);
};

// --- Comandos ----------------------------------------------------------------

const cmdNew = (): void => {
    if (fs.existsSync(WALLET_FILE)) {
        console.error(
            `Ya existe una wallet en ${WALLET_FILE}. Bórrala manualmente si quieres crear otra.`,
        );
        process.exit(1);
    }
    const mnemonic = createMnemonic();
    saveWallet(mnemonic);
    const w = deriveWallet(mnemonic, NETWORK);
    console.log('Wallet creada.\n');
    printWalletHeader(w);
    console.log(`\nMnemónica (12 palabras — ¡guárdala!):\n  ${mnemonic}`);
    console.log(`\nGuardada en: ${WALLET_FILE}`);
    console.log('AVISO: la mnemónica se guarda EN CLARO. Úsala solo en chipnet.');
};

const cmdRestore = (mnemonic: string): void => {
    if (!mnemonic) throw new Error('uso: restore "palabra1 palabra2 ... palabra12"');
    const invalid = validateMnemonic(mnemonic);
    if (invalid) throw new Error(`mnemónica inválida: ${invalid}`);
    saveWallet(mnemonic.trim());
    const w = deriveWallet(mnemonic, NETWORK);
    console.log('Wallet restaurada.\n');
    printWalletHeader(w);
    console.log(`\nGuardada en: ${WALLET_FILE}`);
};

const cmdInfo = (): void => {
    const w = loadWallet();
    printWalletHeader(w);
};

const cmdBalance = async (): Promise<void> => {
    const w = loadWallet();
    printWalletHeader(w);
    const bal = await withClient((c) => c.getBalance(w.address));
    console.log(`\nConfirmado:    ${satsToBch(bal.confirmed)} BCH (${bal.confirmed} sat)`);
    console.log(`Sin confirmar: ${satsToBch(bal.unconfirmed)} BCH (${bal.unconfirmed} sat)`);
    console.log(
        `Total:         ${satsToBch(bal.confirmed + bal.unconfirmed)} BCH`,
    );
};

const cmdHistory = async (): Promise<void> => {
    const w = loadWallet();
    const history = await withClient((c) => c.getHistory(w.address));
    if (history.length === 0) {
        console.log('Sin transacciones.');
        return;
    }
    console.log(`${history.length} transacción(es):`);
    for (const tx of history) {
        const status = tx.height > 0 ? `bloque ${tx.height}` : 'sin confirmar';
        console.log(`  ${tx.tx_hash}  (${status})`);
    }
};

const cmdSend = async (toAddress: string, amountArg: string): Promise<void> => {
    if (!toAddress || !amountArg)
        throw new Error('uso: send <dirección> <importe_bch>');
    const amountSats = bchToSats(Number(amountArg));
    if (!Number.isFinite(amountSats) || amountSats <= 0)
        throw new Error(`importe inválido: ${amountArg}`);
    if (amountSats < DUST_LIMIT)
        throw new Error(`importe por debajo del polvo (${DUST_LIMIT} sat)`);

    const w = loadWallet();

    await withClient(async (client) => {
        const utxos = await client.listUnspent(w.address);
        if (utxos.length === 0) throw new Error('no hay UTXOs disponibles para gastar');

        const result = buildTransaction(w, utxos, toAddress, amountSats);

        console.log('Transacción preparada:');
        console.log(`  Desde:    ${w.address}`);
        console.log(`  Hacia:    ${toAddress}`);
        console.log(`  Importe:  ${satsToBch(amountSats)} BCH (${amountSats} sat)`);
        console.log(`  Comisión: ${satsToBch(result.fee)} BCH (${result.fee} sat)`);
        console.log(`  Cambio:   ${satsToBch(result.change)} BCH (${result.change} sat)`);
        console.log(`  Entradas: ${result.inputsUsed}`);
        console.log(`  TXID:     ${result.txid}`);

        if (!(await confirm('\n¿Firmar y transmitir esta transacción?'))) {
            console.log('Cancelada.');
            return;
        }

        const txid = await client.broadcast(result.rawTxHex);
        console.log(`\n✓ Transmitida. TXID: ${txid}`);
    });
};

const cmdDump = (): void => {
    const w = loadWallet();
    printWalletHeader(w);
    console.log(`Clave pública: ${Buffer.from(w.publicKey).toString('hex')}`);
    console.log('\nMnemónica:');
    console.log(`  ${w.mnemonic}`);
};

const usage = (): void => {
    console.log(`BCH Wallet CLI (chipnet) — @bitauth/libauth

Uso:  node src/cli.ts <comando> [args]

Comandos:
  new                         Crea una wallet nueva y guarda la mnemónica
  restore "<12 palabras>"     Restaura una wallet desde su mnemónica
  info                        Muestra red, ruta de derivación y dirección
  balance                     Consulta el saldo en el servidor
  history                     Lista el historial de transacciones
  send <dirección> <bch>      Envía BCH (añade -y para omitir confirmación)
  dump                        Muestra clave pública y mnemónica (¡sensible!)

Variables de entorno:
  BCH_NETWORK      red: chipnet (def.) | testnet | mainnet
  BCH_SERVER       host del servidor Fulcrum (def. chipnet.imaginary.cash)
  BCH_PORT         puerto TLS (def. 50002)
  BCH_WALLET_FILE  ruta del archivo de wallet (def. ./wallet.json)
`);
};

// --- Enrutado ----------------------------------------------------------------

const main = async (): Promise<void> => {
    const [command, ...args] = process.argv.slice(2).filter((a) => a !== '-y' && a !== '--yes');
    try {
        switch (command) {
            case 'new':
                cmdNew();
                break;
            case 'restore':
                cmdRestore(args.join(' '));
                break;
            case 'info':
            case 'address':
                cmdInfo();
                break;
            case 'balance':
                await cmdBalance();
                break;
            case 'history':
                await cmdHistory();
                break;
            case 'send':
                await cmdSend(args[0], args[1]);
                break;
            case 'dump':
                cmdDump();
                break;
            case undefined:
            case 'help':
            case '--help':
            case '-h':
                usage();
                break;
            default:
                console.error(`Comando desconocido: ${command}\n`);
                usage();
                process.exit(1);
        }
    } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
    }
};

void main();
