# BCH Wallet CLI (chipnet)

*[Versión en español](./README.es.md)*

A simple command-line wallet for **Bitcoin Cash** on **chipnet**, built with
[`@bitauth/libauth`](https://libauth.org/). No extra dependencies: the server
client uses Node's native `tls` module.

## Requirements

- Node.js ≥ 22 (tested on v26; uses native TypeScript support).

## Installation

```bash
git clone https://github.com/Navatante/bch-chipnet-wallet.git
cd bch-chipnet-wallet
npm install
```

This installs the single dependency (`@bitauth/libauth`). There is no build
step: Node runs the TypeScript files directly (`node src/cli.ts …`).

Verify it works:

```bash
npm start          # prints the help
# or directly:
node src/cli.ts help
```

## What it does

- **Single-address** HD wallet: `m/44'/1'/0'/0/0` (BIP39 + BIP44).
- Generates / restores a 12-word mnemonic.
- Queries balance, history and UTXOs from a **Fulcrum** (Electrum) server.
- Builds, **signs** (P2PKH, `SIGHASH_ALL|FORKID`) and **broadcasts** transactions.

Signing is done by hand with `generateSigningSerializationBCH` +
`signMessageHashDER`, and the result is validated against the BCH consensus VM.

## Usage

```bash
node src/cli.ts new                      # create a new wallet
node src/cli.ts restore "word1 ... word12"
node src/cli.ts info                     # network, path and address
node src/cli.ts balance                  # confirmed/unconfirmed balance
node src/cli.ts history                  # transaction history
node src/cli.ts send <address> <bch>     # send BCH (asks for confirmation)
node src/cli.ts send <address> <bch> -y  # skip confirmation
node src/cli.ts dump                      # show pubkey + mnemonic
```

Get some test BCH from a chipnet faucet and send it to the address shown by
`info`. Then try `balance` and `send`.

## Configuration (environment variables)

| Variable          | Default                  | Description                        |
| ----------------- | ------------------------ | ---------------------------------- |
| `BCH_NETWORK`     | `chipnet`                | `chipnet` \| `testnet` \| `mainnet` |
| `BCH_SERVER`      | `chipnet.imaginary.cash` | Fulcrum server host                |
| `BCH_PORT`        | `50002`                  | TLS port                           |
| `BCH_WALLET_FILE` | `./wallet.json`          | wallet file path                   |

## ⚠️ Security

The mnemonic is stored **in plaintext** in `wallet.json` (mode `600`). This is
acceptable **only for chipnet / testing**. Do not use it with real mainnet
funds and do not reuse the mnemonic in a real wallet.

## Structure

- `electrum.ts` — minimal JSON-RPC client for Fulcrum/Electrum over TLS.
- `wallet.ts` — key derivation, addresses and transaction building/signing.
- `cli.ts` — command-line interface and persistence.
