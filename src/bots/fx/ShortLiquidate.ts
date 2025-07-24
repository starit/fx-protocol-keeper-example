import { AbiCoder, concat, ethers, JsonRpcProvider, MaxUint256, toBeHex, Wallet, ZeroAddress } from "ethers";

import { Multicall3__factory } from "../../types";
import { ContractCall, MULTICALL_ADDRESS, useMulticall } from "../../helpers/multicall";
import { delay } from "../../helpers";
import { FEE_PRECISION, ITickToBalance, PRECISION, StateSync } from "./StateSync";
import {
  ARBITRAGE_PROXY,
  DefaultSwapRoute,
  ERC20Interface,
  FxProtocolShortBatchExecutorInterface,
  MaxDebtToLiquidate,
  MULTI_PATH_CONVERTER,
  MultiPathConverterInterface,
  PoolBaseToken,
  PriceOracleInterface,
  RateProviderInterface,
} from "./constants";
import { EthereumTokens } from "../../common";
import { sendTx } from "./helper";
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

const ALARM_TIME = parseInt(process.env.ALARM_TIME || "120000", 10);
const API_URL = process.env.API_LIQUIDATE_V2_URL || "";

const USDC_SCALAR = 10n ** 12n;
const RATES = [USDC_SCALAR, 1n];
const SLIPPAGE = 1n;

interface StableSwap {
  Amp: bigint;
  BaseFee: bigint;
  OffpegFeeMultiplier: bigint;
  usdcInCurve: bigint;
  fxusdInCurve: bigint;
}

function getRawDebtToLiquidate(tick: ITickToBalance, balance: bigint): bigint {
  // rawDebts / price * (1 + bonus) <= position.rawColls + balance
  // rawDebts <= (position.rawColls + balance) / (1 + bonus) * price
  let rawDebts =
    ((((tick.rawColls + balance) * tick.price) / PRECISION) * FEE_PRECISION) / (FEE_PRECISION + tick.bonusRatio);
  (tick.rawColls * tick.price) / PRECISION;
  if (rawDebts > tick.rawDebts) rawDebts = tick.rawDebts;
  return rawDebts;
}

async function handleLiquidate(
  dryRun: boolean,
  usePrivateTx: boolean,
  wallet: Wallet,
  state: StateSync,
  poolAddr: string,
  ticks: Array<ITickToBalance>,
  rates: Record<string, [bigint, bigint]>,
  reserveBalances: Record<string, bigint>,
  maxLiquidity: bigint,
) {
  console.log(`${poolAddr} number of liquidatable ticks: ${ticks.length}`);
  if (ticks.length === 0) return;
  // pick at most 20 positions
  let totalRawDebts = 0n;
  let totalRawBonus = 0n;
  const locks: Array<[string, number]> = [];
  for (let i = 0; i < ticks.length && i < 20; ++i) {
    const tick = ticks[i];
    let debts = getRawDebtToLiquidate(tick, reserveBalances[EthereumTokens.fxUSD.address]);
    if (debts > maxLiquidity) debts = maxLiquidity;
    const bonus =
      (((debts * tick.bonusRatio) / FEE_PRECISION) * (FEE_PRECISION - state.shortPoolManager.liquidationExpenseRatio)) /
      FEE_PRECISION;
    console.log(
      "Liquidate:",
      `Pool[${tick.pool}]`,
      `Tick[${tick.tick}]`,
      `Debts[${ethers.formatEther(debts)}]`,
      `Bonus[${ethers.formatEther(bonus)}]`,
    );
    totalRawDebts += debts;
    totalRawBonus += bonus;
    locks.push([tick.pool, tick.tick]);
    if (totalRawDebts > MaxDebtToLiquidate[poolAddr]) {
      break;
    }
  }
  const scalingFactor = rates[PoolBaseToken[poolAddr]][0] * rates[PoolBaseToken[poolAddr]][1];
  const totalDebts = (totalRawDebts * PRECISION) / scalingFactor;
  const totalBonus = (totalRawBonus * PRECISION) / scalingFactor;

  console.log("Total Debts:", ethers.formatEther(totalDebts * rates[PoolBaseToken[poolAddr]][0]));
  console.log("Total Bonus:", ethers.formatEther(totalBonus * rates[PoolBaseToken[poolAddr]][0]));

  const DustDebtMapping = {
    [EthereumTokens.wstETH.address]: ethers.parseEther("0.000001"),
    [EthereumTokens.WBTC.address]: ethers.parseUnits("0.00000001", 8),
  };
  const FlashLoanDebtMapping = {
    [EthereumTokens.wstETH.address]: ethers.parseEther("0.1"),
    [EthereumTokens.WBTC.address]: ethers.parseUnits("0.0001", 8),
  };

  // debt too small, ignore
  if (totalDebts <= DustDebtMapping[PoolBaseToken[poolAddr]]) return;

  let executorData = "0x";
  if (totalDebts >= FlashLoanDebtMapping[PoolBaseToken[poolAddr]]) {
    // swap fxUSD to debt token, changed to dex aggregator later
    const swapRoute = DefaultSwapRoute[poolAddr];
    const swapData = MultiPathConverterInterface.encodeFunctionData("convert", [
      EthereumTokens.fxUSD.address,
      MaxUint256,
      swapRoute.encoding,
      swapRoute.routes,
    ]);
    const executorEncoding = 1; // liquidate
    const userData = AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [poolAddr, MULTI_PATH_CONVERTER, swapData],
    );
    executorData = FxProtocolShortBatchExecutorInterface.encodeFunctionData("shortRebalanceOrLiquidate", [
      PoolBaseToken[poolAddr],
      (totalDebts * (10000n + SLIPPAGE)) / 10000n,
      concat([toBeHex(executorEncoding), userData]),
    ]);
  } else {
    // liquidate without flashloan
    executorData = FxProtocolShortBatchExecutorInterface.encodeFunctionData("shortLiquidate", [
      poolAddr,
      PoolBaseToken[poolAddr],
    ]);
  }
  if (!dryRun) {
    await sendTx(wallet, ARBITRAGE_PROXY, executorData, usePrivateTx);
    for (const [pool, tick] of locks) {
      state.lockTick(pool, tick, 60);
    }
  } else {
    console.log(`target[${ARBITRAGE_PROXY}]`, `calldata[${executorData}]`);
  }
}

export async function run(options: {
  dry: boolean;
  store: string;
  rpcUrl: string;
  private: string;
  usePrivateTx: boolean;
}) {
  const state = new StateSync(options.store);
  const provider = new JsonRpcProvider(options.rpcUrl);
  const wallet = new Wallet(options.private, provider);
  const multicall = Multicall3__factory.connect(MULTICALL_ADDRESS, provider);
  let _axiosTime = new Date().getTime();
  while (true) {
    try {
      await state.sync(provider);
      if (API_URL != "" && new Date().getTime() - _axiosTime > ALARM_TIME) {
        await axios.get(`${API_URL}`);
        _axiosTime = new Date().getTime();
      }
    } catch (e) {
      console.log("sync error:", e);
      await delay(2000);
      continue;
    }
    try {
      const latest = await provider.getBlockNumber();
      if (latest === state.getLastSyncAt() + 1) {
        // fetch prices and rates
        const calls: ContractCall[] = [];
        Object.entries(state.shortPools).forEach(([_poolAddr, pool]) => {
          calls.push({
            interface: PriceOracleInterface,
            address: pool.oracle,
            method: "getPrice",
            parameters: [],
          });
        });
        Object.entries(state.shortPoolManager.rateProvider).forEach(([tokenAddr, [_scalar, rateAddr]]) => {
          if (rateAddr !== ZeroAddress) {
            calls.push({
              interface: RateProviderInterface,
              address: rateAddr,
              method: "getRate",
              parameters: [],
            });
          }
          calls.push({
            interface: ERC20Interface,
            address: tokenAddr,
            method: "balanceOf",
            parameters: [state.shortPoolManager.reservePoolAddr],
          });
        });
        calls.push({
          interface: ERC20Interface,
          address: EthereumTokens.fxUSD.address,
          method: "balanceOf",
          parameters: [state.shortPoolManager.reservePoolAddr],
        });
        const [, results] = await useMulticall(multicall, calls);
        const prices: Record<string, bigint> = {};
        const rates: Record<string, [bigint, bigint]> = {};
        const reserveBalances: Record<string, bigint> = {};
        Object.entries(state.shortPools).forEach(([poolAddr, _pool]) => {
          const result = results.shift()!;
          prices[poolAddr] = result[1];
        });
        Object.entries(state.shortPoolManager.rateProvider).forEach(([tokenAddr, [scalar, rateAddr]]) => {
          if (rateAddr !== ZeroAddress) {
            const rateResult = results.shift()!;
            rates[tokenAddr] = [scalar, rateResult[0]];
          } else {
            rates[tokenAddr] = [scalar, 10n ** 18n];
          }
          const reserveBalanceResult = results.shift()!;
          reserveBalances[tokenAddr] = reserveBalanceResult[0];
        });
        const fxusdInReserve = results.shift()!;
        reserveBalances[EthereumTokens.fxUSD.address] = fxusdInReserve[0];
        const allTicks = state.getBatchLiquidateShort(prices);
        for (const [pool, ticks] of Object.entries(allTicks)) {
          await handleLiquidate(
            options.dry,
            options.usePrivateTx,
            wallet,
            state,
            pool,
            ticks,
            rates,
            reserveBalances,
            MaxUint256,
          );
        }
      }
      await delay(2000);
    } catch (e) {
      console.log("Rebalance error:", e);
      await delay(10000);
    }
  }
}
