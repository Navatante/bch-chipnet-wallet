import {
    generateBip39Mnemonic,
    decodeBip39Mnemonic,
    deriveHdPrivateNodeFromBip39Mnemonic,
    deriveHdPath,
    secp256k1,
    hash160,
    encodeCashAddress,
    cashAddressToLockingBytecode,
    generateSigningSerializationBCH,
    hash256,
    encodeTransaction,
    encodeDataPush,
    flattenBinArray,
    hexToBin,
    binToHex,
    SigningSerializationType,
    type Input,
    type Output,
    type TransactionCommon,
} from '@bitauth/libauth';
import type { Utxo } from './electrum.ts';

/** Los helpers de secp256k1 devuelven `Uint8Array | string`; el string es error. */
const unwrap = <T>(result: T | string, label: string): T => {
    if (typeof result === 'string') throw new Error(`${label}: ${result}`);
    return result;
};

export type Network = 'chipnet' | 'testnet' | 'mainnet';

/** El prefijo CashAddr por red. Chipnet comparte prefijo con testnet. */
const PREFIX: Record<Network, 'bitcoincash' | 'bchtest'> = {
    mainnet: 'bitcoincash',
    testnet: 'bchtest',
    chipnet: 'bchtest',
};

/**
 * `coin_type` según SLIP-44. Mainnet BCH = 145'; para redes de prueba
 * (testnet/chipnet) se usa 1', como el resto de wallets BCH de test.
 */
const COIN_TYPE: Record<Network, number> = {
    mainnet: 145,
    testnet: 1,
    chipnet: 1,
};

export const DUST_LIMIT = 546; // satoshis
const FEE_RATE = 1.0; // sat/byte (mínimo de retransmisión en BCH)

export interface WalletKeys {
    mnemonic: string;
    network: Network;
    derivationPath: string;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    address: string;
    lockingBytecode: Uint8Array;
}

/** Genera una frase mnemónica BIP39 nueva (12 palabras / 128 bits). */
export const createMnemonic = (): string => generateBip39Mnemonic();

/** Valida una mnemónica BIP39. Devuelve un mensaje de error o `null` si es válida. */
export const validateMnemonic = (mnemonic: string): string | null => {
    const result = decodeBip39Mnemonic(mnemonic.trim());
    return typeof result === 'string' ? result : null;
};

/**
 * Deriva las claves de la wallet a partir de la mnemónica.
 * Usa una wallet de una sola dirección: `m/44'/coin'/0'/0/0`.
 */
export const deriveWallet = (
    mnemonic: string,
    network: Network = 'chipnet',
): WalletKeys => {
    const invalid = validateMnemonic(mnemonic);
    if (invalid) throw new Error(`mnemónica inválida: ${invalid}`);

    const master = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic.trim());
    const derivationPath = `m/44'/${COIN_TYPE[network]}'/0'/0/0`;
    const node = deriveHdPath(master, derivationPath);
    if (typeof node === 'string') throw new Error(`deriveHdPath: ${node}`);

    const privateKey = node.privateKey;
    const publicKey = unwrap(
        secp256k1.derivePublicKeyCompressed(privateKey),
        'derivePublicKeyCompressed',
    );
    const pubKeyHash = hash160(publicKey);
    const { address } = encodeCashAddress({
        payload: pubKeyHash,
        prefix: PREFIX[network],
        type: 'p2pkh',
    });
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string')
        throw new Error(`cashAddressToLockingBytecode: ${decoded}`);

    return {
        mnemonic: mnemonic.trim(),
        network,
        derivationPath,
        privateKey,
        publicKey,
        address,
        lockingBytecode: decoded.bytecode,
    };
};

/** Convierte una dirección CashAddr destino en su locking bytecode (scriptPubKey). */
const addressToLockingBytecode = (address: string): Uint8Array => {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string')
        throw new Error(`dirección inválida "${address}": ${decoded}`);
    return decoded.bytecode;
};

/** Estimación de tamaño de una tx P2PKH: entradas ~148 B, salidas ~34 B. */
const estimateFee = (numInputs: number, numOutputs: number): number =>
    Math.ceil((10 + numInputs * 148 + numOutputs * 34) * FEE_RATE);

export interface BuildResult {
    rawTxHex: string;
    txid: string;
    fee: number;
    change: number;
    inputsUsed: number;
}

/**
 * Construye y firma una transacción P2PKH que envía `amountSats` a `toAddress`,
 * devolviendo el cambio a la propia dirección de la wallet.
 *
 * Selección de monedas: acumula UTXOs (mayores primero) hasta cubrir
 * `amount + fee`. Todos los UTXOs pertenecen a la única dirección de la wallet,
 * así que el `coveredBytecode` de la firma es siempre el mismo.
 */
export const buildTransaction = (
    wallet: WalletKeys,
    utxos: Utxo[],
    toAddress: string,
    amountSats: number,
): BuildResult => {
    if (amountSats < DUST_LIMIT)
        throw new Error(
            `el importe (${amountSats} sat) está por debajo del límite de polvo (${DUST_LIMIT} sat)`,
        );

    const recipientLock = addressToLockingBytecode(toAddress);

    // Selección de monedas: mayores primero para minimizar el número de entradas.
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const selected: Utxo[] = [];
    let inputTotal = 0;
    let fee = 0;
    let covered = false;
    for (const utxo of sorted) {
        selected.push(utxo);
        inputTotal += utxo.value;
        // Estimamos con 2 salidas (destino + cambio) mientras no se cubra.
        fee = estimateFee(selected.length, 2);
        if (inputTotal >= amountSats + fee) {
            covered = true;
            break;
        }
    }
    if (!covered)
        throw new Error(
            `fondos insuficientes: disponible ${inputTotal} sat, se necesitan ${
                amountSats + fee
            } sat (importe + comisión)`,
        );

    // ¿El cambio supera el polvo? Si no, se descarta a favor de la comisión.
    let change = inputTotal - amountSats - fee;
    const outputs: Output[] = [
        { lockingBytecode: recipientLock, valueSatoshis: BigInt(amountSats) },
    ];
    if (change >= DUST_LIMIT) {
        outputs.push({
            lockingBytecode: wallet.lockingBytecode,
            valueSatoshis: BigInt(change),
        });
    } else {
        // Recalcula la comisión con una sola salida y absorbe el resto.
        fee = estimateFee(selected.length, 1);
        fee += change; // el cambio sub-polvo se convierte en comisión
        change = 0;
    }

    // `sourceOutputs` describe los UTXOs gastados (necesario para la firma BCH).
    const sourceOutputs: Output[] = selected.map((u) => ({
        lockingBytecode: wallet.lockingBytecode,
        valueSatoshis: BigInt(u.value),
    }));

    const inputs: Input[] = selected.map((u) => ({
        outpointIndex: u.tx_pos,
        outpointTransactionHash: hexToBin(u.tx_hash),
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(), // placeholder; se rellena al firmar
    }));

    const transaction: TransactionCommon = {
        version: 2,
        locktime: 0,
        inputs,
        outputs,
    };

    // Firma SIGHASH_ALL | FORKID (0x41) para cada entrada.
    const sighashType = Uint8Array.of(SigningSerializationType.allOutputs);
    for (let i = 0; i < inputs.length; i++) {
        const preimage = generateSigningSerializationBCH(
            { inputIndex: i, sourceOutputs, transaction },
            {
                coveredBytecode: wallet.lockingBytecode,
                signingSerializationType: sighashType,
            },
        );
        const sighash = hash256(preimage);
        const der = unwrap(
            secp256k1.signMessageHashDER(wallet.privateKey, sighash),
            'signMessageHashDER',
        );
        const signature = flattenBinArray([der, sighashType]);
        // Unlocking bytecode P2PKH: <sig+hashtype> <pubkey>
        inputs[i].unlockingBytecode = flattenBinArray([
            encodeDataPush(signature),
            encodeDataPush(wallet.publicKey),
        ]);
    }

    const encoded = encodeTransaction(transaction);
    // El TXID es el doble-SHA256 en orden inverso (UI order).
    const txid = binToHex(hash256(encoded).slice().reverse());

    return {
        rawTxHex: binToHex(encoded),
        txid,
        fee,
        change,
        inputsUsed: selected.length,
    };
};

export const satsToBch = (sats: number): string => (sats / 1e8).toFixed(8);
export const bchToSats = (bch: number): number => Math.round(bch * 1e8);
