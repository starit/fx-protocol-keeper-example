import { Command } from "commander";
import { ethers, JsonRpcProvider, toBeHex } from "ethers";

import { EthereumTokens, MULTI_PATH_CONVERTER_ROUTES, showMultiPathRoutes } from "../common";
import { MultiPathConverter__factory } from "../types";

const MULTI_PATH_CONVERTER = "0x12AF4529129303D7FbD2563E242C4a2890525912";

const program = new Command();
program.version("1.0.0");

async function main(src: string, dst: string, verbose: boolean) {
  const { encoding, routes } = MULTI_PATH_CONVERTER_ROUTES[src][dst];
  console.log(`Convert from ${src}[${EthereumTokens[src].address}] to ${dst}[${EthereumTokens[dst].address}]`);
  console.log(" encoding:", encoding.toString());
  console.log(" routes:", JSON.stringify(routes.map((x) => toBeHex(x))));
  if (verbose) {
    console.log(" verbose:");
    showMultiPathRoutes(src, dst, 1);

    const provider = new JsonRpcProvider("https://eth.drpc.org");
    const converter = MultiPathConverter__factory.connect(MULTI_PATH_CONVERTER, provider);
    for (const amountIn of ["0.1", "10", "1000", "10000", "100000", "1000000", "10000000"]) {
      const amountOut = await converter.queryConvert.staticCall(
        ethers.parseUnits(amountIn, EthereumTokens[src].decimals),
        encoding,
        routes,
      );
      console.log(
        `  try convert ${src}[${amountIn}] to ${dst}[${ethers.formatUnits(amountOut, EthereumTokens[dst].decimals)}]`,
      );
    }
  }
}

program.option("-s, --src <source token>", "the symbol of source token");
program.option("-t, --target <target token>", "the symbol of target token");
program.option("--verbose", "whether to show details of the path");
program.parse(process.argv);
const options = program.opts();

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main(options.src, options.target, options.verbose).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
