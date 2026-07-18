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
            `no wallet found at ${WALLET_FILE}. Create one with "new" or "restore".`,
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
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === 'y' || answer === 'yes';
};

const printWalletHeader = (w: WalletKeys): void => {
    console.log(`Network: ${w.network} (server ${SERVER_HOST}:${SERVER_PORT})`);
    console.log(`Path:    ${w.derivationPath}`);
    console.log(`Address: ${w.address}`);
};

// --- Comandos ----------------------------------------------------------------

const cmdNew = (): void => {
    if (fs.existsSync(WALLET_FILE)) {
        console.error(
            `A wallet already exists at ${WALLET_FILE}. Delete it manually if you want to create another.`,
        );
        process.exit(1);
    }
    const mnemonic = createMnemonic();
    saveWallet(mnemonic);
    const w = deriveWallet(mnemonic, NETWORK);
    console.log('Wallet created.\n');
    printWalletHeader(w);
    console.log(`\nMnemonic (12 words — keep it safe!):\n  ${mnemonic}`);
    console.log(`\nSaved to: ${WALLET_FILE}`);
    console.log('WARNING: the mnemonic is stored in PLAINTEXT. Use it only on chipnet.');
};

const cmdRestore = (mnemonic: string): void => {
    if (!mnemonic) throw new Error('usage: restore "word1 word2 ... word12"');
    const invalid = validateMnemonic(mnemonic);
    if (invalid) throw new Error(`invalid mnemonic: ${invalid}`);
    saveWallet(mnemonic.trim());
    const w = deriveWallet(mnemonic, NETWORK);
    console.log('Wallet restored.\n');
    printWalletHeader(w);
    console.log(`\nSaved to: ${WALLET_FILE}`);
};

const cmdInfo = (): void => {
    const w = loadWallet();
    printWalletHeader(w);
};

const cmdBalance = async (): Promise<void> => {
    const w = loadWallet();
    printWalletHeader(w);
    const bal = await withClient((c) => c.getBalance(w.address));
    console.log(`\nConfirmed:   ${satsToBch(bal.confirmed)} BCH (${bal.confirmed} sat)`);
    console.log(`Unconfirmed: ${satsToBch(bal.unconfirmed)} BCH (${bal.unconfirmed} sat)`);
    console.log(
        `Total:       ${satsToBch(bal.confirmed + bal.unconfirmed)} BCH`,
    );
};

const cmdHistory = async (): Promise<void> => {
    const w = loadWallet();
    const history = await withClient((c) => c.getHistory(w.address));
    if (history.length === 0) {
        console.log('No transactions.');
        return;
    }
    console.log(`${history.length} transaction(s):`);
    for (const tx of history) {
        const status = tx.height > 0 ? `block ${tx.height}` : 'unconfirmed';
        console.log(`  ${tx.tx_hash}  (${status})`);
    }
};

const cmdSend = async (toAddress: string, amountArg: string): Promise<void> => {
    if (!toAddress || !amountArg)
        throw new Error('usage: send <address> <amount_bch>');
    const amountSats = bchToSats(Number(amountArg));
    if (!Number.isFinite(amountSats) || amountSats <= 0)
        throw new Error(`invalid amount: ${amountArg}`);
    if (amountSats < DUST_LIMIT)
        throw new Error(`amount below dust limit (${DUST_LIMIT} sat)`);

    const w = loadWallet();

    await withClient(async (client) => {
        const utxos = await client.listUnspent(w.address);
        if (utxos.length === 0) throw new Error('no UTXOs available to spend');

        const result = buildTransaction(w, utxos, toAddress, amountSats);

        console.log('Transaction prepared:');
        console.log(`  From:   ${w.address}`);
        console.log(`  To:     ${toAddress}`);
        console.log(`  Amount: ${satsToBch(amountSats)} BCH (${amountSats} sat)`);
        console.log(`  Fee:    ${satsToBch(result.fee)} BCH (${result.fee} sat)`);
        console.log(`  Change: ${satsToBch(result.change)} BCH (${result.change} sat)`);
        console.log(`  Inputs: ${result.inputsUsed}`);
        console.log(`  TXID:   ${result.txid}`);

        if (!(await confirm('\nSign and broadcast this transaction?'))) {
            console.log('Cancelled.');
            return;
        }

        const txid = await client.broadcast(result.rawTxHex);
        console.log(`\n✓ Broadcast. TXID: ${txid}`);
    });
};

const cmdDump = (): void => {
    const w = loadWallet();
    printWalletHeader(w);
    console.log(`Public key: ${Buffer.from(w.publicKey).toString('hex')}`);
    console.log('\nMnemonic:');
    console.log(`  ${w.mnemonic}`);
};

const usage = (): void => {
    console.log(`BCH Wallet CLI (chipnet) — @bitauth/libauth

Usage:  node src/cli.ts <command> [args]

Commands:
  new                       Create a new wallet and save the mnemonic
  restore "<12 words>"      Restore a wallet from its mnemonic
  info                      Show network, derivation path and address
  balance                   Query the balance from the server
  history                   List the transaction history
  send <address> <bch>      Send BCH (add -y to skip confirmation)
  dump                      Show public key and mnemonic (sensitive!)

Environment variables:
  BCH_NETWORK      network: chipnet (default) | testnet | mainnet
  BCH_SERVER       Fulcrum server host (default chipnet.imaginary.cash)
  BCH_PORT         TLS port (default 50002)
  BCH_WALLET_FILE  wallet file path (default ./wallet.json)
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
                console.error(`Unknown command: ${command}\n`);
                usage();
                process.exit(1);
        }
    } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
    }
};

void main();
