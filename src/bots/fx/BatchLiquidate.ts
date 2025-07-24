import { AbiCoder, concat, ethers, JsonRpcProvider, MaxUint256, toBeHex, Wallet, ZeroAddress } from "ethers";

import { Multicall3__factory } from "../../types";
import { ContractCall, MULTICALL_ADDRESS, useMulticall } from "../../helpers/multicall";
import { delay } from "../../helpers";
import { FEE_PRECISION, ITickToBalance, PRECISION, StateSync } from "./StateSync";
import {
  ARBITRAGE_PROXY,
  CurveStableSwapNGInterface,
  DefaultSwapRoute,
  ERC20Interface,
  FxProtocolBatchV2ExecutorInterface,
  FxProtocolLongBatchExecutorInterface,
  FXUSD_BASE_POOL,
  FxUSDBasePoolInterface,
  MULTI_PATH_CONVERTER,
  MultiPathConverterInterface,
  PoolBaseToken,
  PriceOracleInterface,
  RateProviderInterface,
  USDC_fxUSD_CURVE_POOL,
} from "./constants";
import { EthereumTokens } from "../../common";
import { sendTx } from "./helper";
import { getDy } from "./stable";
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
  swap: StableSwap,
  arbitrageBalances: Record<string, bigint>,
) {
  console.log(`${poolAddr} number of liquidatable ticks: ${ticks.length}`);
  if (ticks.length === 0) return;
  // pick at most 20 positions
  let totalDebts = 0n;
  let totalBonus = 0n;
  const locks: Array<[string, number]> = [];
  for (let i = 0; i < ticks.length && i < 20; ++i) {
    const tick = ticks[i];
    let debts = getRawDebtToLiquidate(tick, reserveBalances[tick.token]);
    if (debts > maxLiquidity) debts = maxLiquidity;
    const bonus =
      (((debts * tick.bonusRatio) / FEE_PRECISION) * (FEE_PRECISION - state.manager.liquidationExpenseRatio)) /
      FEE_PRECISION;
    console.log(
      "Liquidate:",
      `Pool[${tick.pool}]`,
      `Tick[${tick.tick}]`,
      `Debts[${ethers.formatEther(debts)}]`,
      `Repay[${ethers.formatEther(debts)} fxUSD]`,
      `Bonus[${ethers.formatEther(bonus)}]`,
    );
    totalDebts += debts;
    totalBonus += bonus;
    locks.push([tick.pool, tick.tick]);
    // liquidate no more than 1 million fxUSD
    if (totalDebts > ethers.parseEther("1000000")) break;
  }
  // debt too small, ignore
  if (totalDebts <= ethers.parseEther("0.01")) return;
  let executorData = "0x";
  if (totalDebts >= ethers.parseEther("1000")) {
    // use flashloan
    const swapped = getDy(
      [swap.usdcInCurve, swap.fxusdInCurve],
      RATES,
      swap.Amp,
      swap.BaseFee,
      swap.OffpegFeeMultiplier,
      0,
      1,
      totalDebts / USDC_SCALAR,
    );
    const useFxUSD = swapped > totalDebts;
    // swap collateral token to USDC, changed to dex aggregator later
    const swapRoute = DefaultSwapRoute[poolAddr];
    const swapData = MultiPathConverterInterface.encodeFunctionData("convert", [
      PoolBaseToken[poolAddr],
      MaxUint256,
      swapRoute.encoding,
      swapRoute.routes,
    ]);
    const executorEncoding = (useFxUSD ? 1 : 0) + 2; // liquidate
    const userData = AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [poolAddr, MULTI_PATH_CONVERTER, swapData],
    );
    executorData = FxProtocolLongBatchExecutorInterface.encodeFunctionData("rebalanceOrLiquidateV2WithCreditNote", [
      ((totalDebts / USDC_SCALAR) * (10000n + SLIPPAGE)) / 10000n,
      concat([toBeHex(executorEncoding), userData]),
    ]);
  } else {
    const usdcAmount = arbitrageBalances[EthereumTokens.USDC.address];
    const fxUSDAmount = arbitrageBalances[EthereumTokens.fxUSD.address] / USDC_SCALAR;
    // liquidate without flashloan
    executorData = FxProtocolBatchV2ExecutorInterface.encodeFunctionData("liquidateV2", [
      poolAddr,
      usdcAmount > fxUSDAmount ? EthereumTokens.USDC.address : EthereumTokens.fxUSD.address,
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
        Object.entries(state.pools).forEach(([_poolAddr, pool]) => {
          calls.push({
            interface: PriceOracleInterface,
            address: pool.oracle,
            method: "getPrice",
            parameters: [],
          });
        });
        Object.entries(state.manager.rateProvider).forEach(([tokenAddr, [_scalar, rateAddr]]) => {
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
            parameters: [state.manager.reservePoolAddr],
          });
        });
        calls.push({
          interface: FxUSDBasePoolInterface,
          address: FXUSD_BASE_POOL,
          method: "totalYieldToken",
          parameters: [],
        });
        calls.push({
          interface: FxUSDBasePoolInterface,
          address: FXUSD_BASE_POOL,
          method: "totalStableToken",
          parameters: [],
        });
        calls.push({
          interface: FxUSDBasePoolInterface,
          address: FXUSD_BASE_POOL,
          method: "getStableTokenPriceWithScale",
          parameters: [],
        });
        calls.push({
          interface: CurveStableSwapNGInterface,
          address: USDC_fxUSD_CURVE_POOL,
          method: "A_precise",
          parameters: [],
        });
        calls.push({
          interface: CurveStableSwapNGInterface,
          address: USDC_fxUSD_CURVE_POOL,
          method: "fee",
          parameters: [],
        });
        calls.push({
          interface: CurveStableSwapNGInterface,
          address: USDC_fxUSD_CURVE_POOL,
          method: "offpeg_fee_multiplier",
          parameters: [],
        });
        calls.push({
          interface: CurveStableSwapNGInterface,
          address: USDC_fxUSD_CURVE_POOL,
          method: "balances",
          parameters: [0],
        });
        calls.push({
          interface: CurveStableSwapNGInterface,
          address: USDC_fxUSD_CURVE_POOL,
          method: "balances",
          parameters: [1],
        });
        calls.push({
          interface: ERC20Interface,
          address: EthereumTokens.USDC.address,
          method: "balanceOf",
          parameters: [ARBITRAGE_PROXY],
        });
        calls.push({
          interface: ERC20Interface,
          address: EthereumTokens.fxUSD.address,
          method: "balanceOf",
          parameters: [ARBITRAGE_PROXY],
        });
        const [, results] = await useMulticall(multicall, calls);
        const prices: Record<string, bigint> = {};
        const rates: Record<string, [bigint, bigint]> = {};
        const reserveBalances: Record<string, bigint> = {};
        const arbitrageBalances: Record<string, bigint> = {};
        const swap: StableSwap = {
          Amp: 0n,
          BaseFee: 0n,
          OffpegFeeMultiplier: 0n,
          usdcInCurve: 0n,
          fxusdInCurve: 0n,
        };
        Object.entries(state.pools).forEach(([poolAddr, _pool]) => {
          const result = results.shift()!;
          prices[poolAddr] = result[1];
        });
        Object.entries(state.manager.rateProvider).forEach(([tokenAddr, [scalar, rateAddr]]) => {
          if (rateAddr !== ZeroAddress) {
            const rateResult = results.shift()!;
            rates[tokenAddr] = [scalar, rateResult[0]];
          } else {
            rates[tokenAddr] = [scalar, 10n ** 18n];
          }
          const balanceResult = results.shift()!;
          reserveBalances[tokenAddr] = balanceResult[0];
        });
        const fxusdInBase: bigint = results.shift()![0];
        const usdcInBase: bigint = results.shift()![0];
        const usdcPrice: bigint = results.shift()![0];
        swap.Amp = results.shift()![0];
        swap.BaseFee = results.shift()![0];
        swap.OffpegFeeMultiplier = results.shift()![0];
        swap.usdcInCurve = results.shift()![0];
        swap.fxusdInCurve = results.shift()![0];
        arbitrageBalances[EthereumTokens.USDC.address] = results.shift()![0];
        arbitrageBalances[EthereumTokens.fxUSD.address] = results.shift()![0];
        const maxLiquidity = fxusdInBase + (usdcInBase * usdcPrice) / PRECISION;

        const allTicks = state.getBatchLiquidate(prices);
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
            maxLiquidity,
            swap,
            arbitrageBalances,
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
