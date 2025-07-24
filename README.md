# fx-keeper-example

This is an example implementation of keeper bots for the f(x) protocol. This repository demonstrates how to build and use keeper bots.

**Use at your own risk.**

## prerequisite

- yarn: `1.22.22`
- node: run `nvm use`

## Bots

- f(x) bots: use `yarn bot:fx --help` for help. add `-d` for dry run.

## Usage Guide

### Contract Deployment

1. First, deploy the `ArbitrageProxy` contract yourself. This contract uses flash loans to help keepers complete necessary operations. The contract source code is located in `src/bots/contracts`. Please refer to the [README](src/bots/contracts/README.md) for deployment instructions and to obtain the `ArbitrageProxy` address.

2. Update `constants.ts` with the deployed `ArbitrageProxy` contract address.

### f(x) Rebalance Bot for long/short pools

By default, this bot works with long pools. Add the `--short` flag to work with short pools.

```bash
# dry run
yarn bot:fx rebalance -s <directory for state> -r <Rpc Url> -p <private key> -d [--short]
# real run
yarn bot:fx rebalance -s <directory for state> -r <Rpc Url> -p <private key> [--short]
```

### f(x) Liquidate Bot for long/short pools

By default, this bot works with long pools. Add the `--short` flag to work with short pools.

```bash
# dry run
yarn bot:fx liquidate -s <directory for state> -r <Rpc Url> -p <private key> -d [--short]
# real run
yarn bot:fx liquidate -s <directory for state> -r <Rpc Url> -p <private key> [--short]
```

### Use with private 

- add `--use-private-tx` to enable private transaction mode.

## Disclaimer

This software is provided "as is" without any warranties or guarantees. The keeper bots interact with DeFi protocols and involve financial risks. Users are solely responsible for:

- Understanding the risks involved in running keeper bots
- Ensuring compliance with applicable laws and regulations
- Any financial losses that may occur from using this software
- Properly securing private keys and managing access controls

**The authors and contributors are not liable for any damages, losses, or issues arising from the use of this software.**

Always test thoroughly in a safe environment before running in production.