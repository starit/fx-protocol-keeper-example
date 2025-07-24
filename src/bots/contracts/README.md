## Fx keeper example contracts



## Documentation

https://book.getfoundry.sh/

## Usage

- First of all, please change the `_managers` and `_operators` addresses in Deploy.s.sol and replace it with your own addresses.

- Then, update your private key with 'PRIVATE_KEY' in `.env`

- Build and deploy

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
