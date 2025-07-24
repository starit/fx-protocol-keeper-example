import { Command } from "commander";
import { hexlify, randomBytes } from "ethers";

import * as BatchRebalance from "./BatchRebalance";
import * as BatchLiquidate from "./BatchLiquidate";
import * as ShortLiquidate from "./ShortLiquidate";
import * as ShortRebalance from "./ShortRebalance";

const program = new Command();
program.name("fx-bots");
program.description("f(x) protocol related bots");
program.version("1.0.0");

async function main() {
  program.option("-s, --store <DIRECTORY>", "the directory to store metadata");
  program.option("-r, --rpc-url <Rpc Url>", "the rpc url for Ethereum", "https://eth.drpc.org");
  program.option("-p, --private <private key>", "the private key of signer");
  program.option("-d, --dry-run", "dry run and not sending tx");
  program.option("--use-private-tx", "whether to use private tx");
  program.option("--short", "for short pools");

  const rebalance = program.command("rebalance").description("Bot for rebalance and liquidation");
  rebalance.action(async () => {
    const options = program.opts();

    if (options.short) {
      await ShortRebalance.run({
        dry: options.dryRun,
        usePrivateTx: options.usePrivateTx,
        store: options.store,
        rpcUrl: options.rpcUrl,
        private: options.private ?? hexlify(randomBytes(32)),
      });
    } else {
      await BatchRebalance.run({
        dry: options.dryRun,
        usePrivateTx: options.usePrivateTx,
        store: options.store,
        rpcUrl: options.rpcUrl,
        private: options.private ?? hexlify(randomBytes(32)),
      });
    }

  });

  const liquidate = program.command("liquidate").description("Bot for liquidation");
  liquidate.action(async () => {
    const options = program.opts();
    if (options.short) {
      await ShortLiquidate.run({
        dry: options.dryRun,
        usePrivateTx: options.usePrivateTx,
        store: options.store,
        rpcUrl: options.rpcUrl,
        private: options.private ?? hexlify(randomBytes(32)),
      });
    } else {
      await BatchLiquidate.run({
        dry: options.dryRun,
        usePrivateTx: options.usePrivateTx,
        store: options.store,
        rpcUrl: options.rpcUrl,
        private: options.private ?? hexlify(randomBytes(32)),
      });
    }
  });
  await program.parseAsync(process.argv);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
