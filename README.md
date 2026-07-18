# BCH Wallet CLI (chipnet)

*[English version](./README.en.md)*

Wallet sencilla de línea de comandos para **Bitcoin Cash** sobre **chipnet**,
construida con [`@bitauth/libauth`](https://libauth.org/). Sin dependencias
extra: el cliente del servidor usa el módulo `tls` nativo de Node.

## Requisitos

- Node.js ≥ 22 (probado con v26; usa el soporte nativo de TypeScript).

## Instalación

```bash
git clone https://github.com/Navatante/bch-chipnet-wallet.git
cd bch-chipnet-wallet
npm install
```

Esto instala la única dependencia (`@bitauth/libauth`). No hace falta ningún
paso de compilación: Node ejecuta los archivos TypeScript directamente
(`node src/cli.ts …`).

Comprueba que todo funciona:

```bash
npm start          # muestra la ayuda
# o directamente:
node src/cli.ts help
```

## Qué hace

- Wallet HD de **una sola dirección**: `m/44'/1'/0'/0/0` (BIP39 + BIP44).
- Genera / restaura una mnemónica de 12 palabras.
- Consulta saldo, historial y UTXOs desde un servidor **Fulcrum** (Electrum).
- Construye, **firma** (P2PKH, `SIGHASH_ALL|FORKID`) y **transmite** transacciones.

La firma se hace a mano con `generateSigningSerializationBCH` +
`signMessageHashDER`, y el resultado se valida contra la VM de consenso de BCH.

## Uso

```bash
node src/cli.ts new                      # crea una wallet nueva
node src/cli.ts restore "palabra1 ... palabra12"
node src/cli.ts info                     # red, ruta y dirección
node src/cli.ts balance                  # saldo confirmado/sin confirmar
node src/cli.ts history                  # historial de transacciones
node src/cli.ts send <dirección> <bch>   # enviar BCH (pide confirmación)
node src/cli.ts send <dirección> <bch> -y   # sin confirmación
node src/cli.ts dump                      # ver pubkey + mnemónica
```

Consigue BCH de prueba en un faucet de chipnet y envíalo a la dirección que
muestra `info`. Luego `balance` y `send`.

## Configuración (variables de entorno)

| Variable          | Por defecto              | Descripción                        |
| ----------------- | ------------------------ | ---------------------------------- |
| `BCH_NETWORK`     | `chipnet`                | `chipnet` \| `testnet` \| `mainnet` |
| `BCH_SERVER`      | `chipnet.imaginary.cash` | host del servidor Fulcrum          |
| `BCH_PORT`        | `50002`                  | puerto TLS                         |
| `BCH_WALLET_FILE` | `./wallet.json`          | ruta del archivo de wallet         |

## ⚠️ Seguridad

La mnemónica se guarda **en claro** en `wallet.json` (permisos `600`). Esto es
aceptable **solo para chipnet / pruebas**. No la uses con fondos reales de
mainnet ni reutilices la mnemónica en una wallet real.

## Estructura

- `electrum.ts` — cliente JSON-RPC mínimo para Fulcrum/Electrum sobre TLS.
- `wallet.ts` — derivación de claves, direcciones y construcción/firma de tx.
- `cli.ts` — interfaz de línea de comandos y persistencia.
