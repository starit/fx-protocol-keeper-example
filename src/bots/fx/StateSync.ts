import { ethers, JsonRpcProvider, ZeroAddress } from "ethers";
import * as fs from "fs";
import * as path from "path";

import { EthereumTokens } from "../../common";
import { AaveFundingPool__factory, PoolManager__factory } from "../../types";
import {
  POOL_MANAGER,
  RESERVE_POOL,
  WSTETH_POOL,
  WBTC_POOL,
  SHORT_POOL_MANAGER,
  WBTC_SHORT_POOL,
  WSTETH_SHORT_POOL,
} from "./constants";
import { same } from "../../helpers";

const AaveFundingPoolInterface = AaveFundingPool__factory.createInterface();
const PoolManagerInterface = PoolManager__factory.createInterface();

interface IPoolDiskData {
  Address: string;
  CollateralToken: string;
  PriceOracle: string;
  CollIndex: string;
  DebtIndex: string;
  RedeemStatus: boolean;
  MaxRedeemRatioPerTick: string;
  RebalanceDebtRatio: string;
  RebalanceBonusRatio: string;
  LiquidateDebtRatio: string;
  LiquidateBonusRatio: string;
  Ticks: Array<{
    Tick: number;
    Debts: string;
    Colls: string;
  }>;
  Positions: Array<{
    Tick: number;
    Debts: string;
    Colls: string;
  }>;
}

interface IPoolManagerDiskData {
  Address: string;
  ReservePoolAddress: string;
  RedeemFeeRatio: string;
  LiquidationExpenseRatio: string;
  RateProvider: Array<[string, string, string]>;
}

interface StateInDisk {
  LastSyncAt: number;
  LastSyncBlock: Record<string, number>;
  PoolManager: IPoolManagerDiskData;
  ShortPoolManager: IPoolManagerDiskData;
  Pools: Array<IPoolDiskData>;
  ShortPools: Array<IPoolDiskData>;
}

interface IPosition {
  tick: number;
  debts: bigint;
  colls: bigint;
}

interface ITick {
  debts: bigint;
  colls: bigint;
}

export interface ITickToBalance {
  pool: string;
  token: string;
  tick: number;
  price: bigint;
  rawDebts: bigint;
  rawColls: bigint;
  debtRatio: bigint;
  bonusRatio: bigint;
}

export interface IPositionToLiquidate {
  pool: string;
  token: string;
  position: number;
  price: bigint;
  rawDebts: bigint;
  rawColls: bigint;
  debtRatio: bigint;
  bonusRatio: bigint;
}

export const TICK_OFFSET = 32768;
const E96 = 2n ** 96n;

export const PRECISION = 10n ** 18n;
export const FEE_PRECISION = 10n ** 9n;

export class StateSync {
  public readonly manager: {
    address: string;
    reservePoolAddr: string;
    redeemFeeRatio: bigint;
    liquidationExpenseRatio: bigint;
    rateProvider: Record<string, [bigint, string]>;
  };
  public readonly pools: Record<
    string,
    {
      token: string;
      oracle: string;
      collIndex: bigint;
      debtIndex: bigint;
      redeemStatus: boolean;
      maxRedeemRatioPerTick: bigint;
      rebalanceDebtRatio: bigint;
      rebalanceBonusRatio: bigint;
      liquidateDebtRatio: bigint;
      liquidateBonusRatio: bigint;
      ticks: Array<ITick>;
      positions: Array<IPosition>;
    }
  >;
  public readonly shortPoolManager: {
    address: string;
    reservePoolAddr: string;
    redeemFeeRatio: bigint;
    liquidationExpenseRatio: bigint;
    rateProvider: Record<string, [bigint, string]>;
  };
  public readonly shortPools: Record<
    string,
    {
      token: string;
      oracle: string;
      collIndex: bigint;
      debtIndex: bigint;
      redeemStatus: boolean;
      maxRedeemRatioPerTick: bigint;
      rebalanceDebtRatio: bigint;
      rebalanceBonusRatio: bigint;
      liquidateDebtRatio: bigint;
      liquidateBonusRatio: bigint;
      ticks: Array<ITick>;
      positions: Array<IPosition>;
    }
  >;
  public readonly lastSyncBlock: Record<string, number>;
  public statePath: string;
  private tickLock: Record<string, Record<number, number>>;
  private positionLock: Record<string, Record<number, number>>;

  constructor(statePath: string) {
    this.statePath = statePath;

    // initialize state
    this.pools = {};
    this.shortPools = {};
    this.lastSyncBlock = {};
    this.lastSyncBlock[POOL_MANAGER] = 21529327;
    this.lastSyncBlock[WSTETH_POOL] = 21529327;
    this.lastSyncBlock[WBTC_POOL] = 22067306;
    this.lastSyncBlock[SHORT_POOL_MANAGER] = 22953614;
    this.lastSyncBlock[WSTETH_SHORT_POOL] = 22953614;
    this.manager = {
      address: POOL_MANAGER,
      reservePoolAddr: RESERVE_POOL,
      redeemFeeRatio: 0n,
      liquidationExpenseRatio: 0n,
      rateProvider: {},
    };
    this.shortPoolManager = {
      address: SHORT_POOL_MANAGER,
      reservePoolAddr: RESERVE_POOL,
      redeemFeeRatio: 0n,
      liquidationExpenseRatio: 0n,
      rateProvider: {},
    };
    this.pools[WSTETH_POOL] = {
      token: EthereumTokens.wstETH.address,
      oracle: ZeroAddress,
      collIndex: E96,
      debtIndex: E96,
      redeemStatus: true,
      maxRedeemRatioPerTick: 0n,
      rebalanceDebtRatio: 0n,
      rebalanceBonusRatio: 0n,
      liquidateDebtRatio: 0n,
      liquidateBonusRatio: 0n,
      ticks: new Array(65536),
      positions: [
        {
          tick: -65536,
          debts: 0n,
          colls: 0n,
        },
      ],
    };
    this.pools[WBTC_POOL] = {
      token: EthereumTokens.WBTC.address,
      oracle: ZeroAddress,
      collIndex: E96,
      debtIndex: E96,
      redeemStatus: true,
      maxRedeemRatioPerTick: 0n,
      rebalanceDebtRatio: 0n,
      rebalanceBonusRatio: 0n,
      liquidateDebtRatio: 0n,
      liquidateBonusRatio: 0n,
      ticks: new Array(65536),
      positions: [
        {
          tick: -65536,
          debts: 0n,
          colls: 0n,
        },
      ],
    };
    this.shortPools[WSTETH_SHORT_POOL] = {
      token: EthereumTokens.wstETH.address,
      oracle: ZeroAddress,
      collIndex: E96,
      debtIndex: E96,
      redeemStatus: true,
      maxRedeemRatioPerTick: 0n,
      rebalanceDebtRatio: 0n,
      rebalanceBonusRatio: 0n,
      liquidateDebtRatio: 0n,
      liquidateBonusRatio: 0n,
      ticks: new Array(65536),
      positions: [
        {
          tick: -65536,
          debts: 0n,
          colls: 0n,
        },
      ],
    };
    /*
    this.shortPools[WBTC_SHORT_POOL] = {
      token: EthereumTokens.WBTC.address,
      oracle: ZeroAddress,
      collIndex: E96,
      debtIndex: E96,
      redeemStatus: true,
      maxRedeemRatioPerTick: 0n,
      rebalanceDebtRatio: 0n,
      rebalanceBonusRatio: 0n,
      liquidateDebtRatio: 0n,
      liquidateBonusRatio: 0n,
      ticks: new Array(65536),
      positions: [
        {
          tick: -65536,
          debts: 0n,
          colls: 0n,
        },
      ],
    };
    */
    for (let i = 0; i < 65536; ++i) {
      this.pools[WSTETH_POOL].ticks[i] = {
        debts: 0n,
        colls: 0n,
      };
      this.pools[WBTC_POOL].ticks[i] = {
        debts: 0n,
        colls: 0n,
      };
      this.shortPools[WSTETH_SHORT_POOL].ticks[i] = {
        debts: 0n,
        colls: 0n,
      };
      /*
      this.shortPools[WBTC_SHORT_POOL].ticks[i] = {
        debts: 0n,
        colls: 0n,
      };
      */
    }
    this.tickLock = {};
    this.positionLock = {};

    // try load state from db
    this.loadState();
  }

  public getLastSyncAt() {
    return Math.min(...Object.values(this.lastSyncBlock));
  }

  public async sync(provider: JsonRpcProvider) {
    const minSyncBlock = Math.min(...Object.values(this.lastSyncBlock));
    const maxSyncBlock = Math.max(...Object.values(this.lastSyncBlock));
    if (minSyncBlock < maxSyncBlock) {
      console.log("Make all contracts synced", "minSyncBlock:", minSyncBlock, "maxSyncBlock:", maxSyncBlock);
      await this.syncInternal(provider, minSyncBlock + 1, maxSyncBlock);
    } else {
      // always minus one to avoid reorg in Ethereum
      const latest = (await provider.getBlockNumber()) - 1;
      await this.syncInternal(provider, maxSyncBlock + 1, latest);
    }
  }

  public getTicksToRebalance(prices: Record<string, bigint>): Record<string, Array<ITickToBalance>> {
    const now = Date.now() / 1000;
    const results: Record<string, Array<ITickToBalance>> = {};
    for (const poolAddr of Object.keys(prices)) {
      const poolResults: Array<ITickToBalance> = [];
      const pool = this.pools[poolAddr];
      const lock = this.tickLock[poolAddr];
      for (let i = pool.ticks.length - 1; i >= 0; --i) {
        if (pool.ticks[i].debts === 0n) continue;
        if (lock && (lock[i - TICK_OFFSET] ?? 0) > now) continue; // ignore locked tick
        const rawColls = (pool.ticks[i].colls * E96) / pool.collIndex;
        const rawDebts = (pool.ticks[i].debts * pool.debtIndex) / E96;
        const price = prices[poolAddr];
        if (rawDebts * PRECISION * PRECISION < pool.rebalanceDebtRatio * rawColls * price) continue;
        if (rawDebts * PRECISION * PRECISION >= pool.liquidateDebtRatio * rawColls * price) continue;
        poolResults.push({
          pool: poolAddr,
          token: pool.token,
          tick: i - TICK_OFFSET,
          price,
          rawColls,
          rawDebts,
          debtRatio: pool.rebalanceDebtRatio,
          bonusRatio: pool.rebalanceBonusRatio,
        });
      }
      results[poolAddr] = poolResults;
    }
    return results;
  }

  public getPositionsToLiquidate(prices: Record<string, bigint>): Record<string, Array<IPositionToLiquidate>> {
    const now = Date.now() / 1000;
    const results: Record<string, Array<IPositionToLiquidate>> = {};
    for (const poolAddr of Object.keys(prices)) {
      const poolResults: Array<IPositionToLiquidate> = [];
      const pool = this.pools[poolAddr];
      const lock = this.positionLock[poolAddr];
      for (let i = 1; i < pool.positions.length; ++i) {
        if (pool.positions[i].debts === 0n) continue;
        if (lock && (lock[i] ?? 0) > now) continue; // ignore locked position
        const rawColls = (pool.positions[i].colls * E96) / pool.collIndex;
        const rawDebts = (pool.positions[i].debts * pool.debtIndex) / E96;
        const price = prices[poolAddr];
        if (rawDebts * PRECISION * PRECISION < pool.liquidateDebtRatio * rawColls * price) continue;
        poolResults.push({
          pool: poolAddr,
          token: pool.token,
          position: i,
          price,
          rawColls,
          rawDebts,
          debtRatio: pool.liquidateDebtRatio,
          bonusRatio: pool.liquidateBonusRatio,
        });
      }
      results[poolAddr] = poolResults;
    }
    return results;
  }

  public getBatchRebalance(prices: Record<string, bigint>): Record<string, Array<ITickToBalance>> {
    const now = Date.now() / 1000;
    const results: Record<string, Array<ITickToBalance>> = {};
    for (const poolAddr of Object.keys(prices)) {
      const poolResults: Array<ITickToBalance> = [];
      const pool = this.pools[poolAddr];
      const lock = this.tickLock[poolAddr];
      for (let i = pool.ticks.length - 1; i >= 0; --i) {
        if (pool.ticks[i].debts === 0n) continue;
        if (lock && (lock[i - TICK_OFFSET] ?? 0) > now) continue; // ignore locked tick
        const rawColls = (pool.ticks[i].colls * E96) / pool.collIndex;
        const rawDebts = (pool.ticks[i].debts * pool.debtIndex) / E96;
        const price = prices[poolAddr];
        if (rawDebts * PRECISION * PRECISION >= pool.liquidateDebtRatio * rawColls * price) continue;
        if (rawDebts < 10n ** 9n) continue;
        if (rawDebts * PRECISION * PRECISION < pool.rebalanceDebtRatio * rawColls * price) break;
        poolResults.push({
          pool: poolAddr,
          token: pool.token,
          tick: i - TICK_OFFSET,
          price,
          rawColls,
          rawDebts,
          debtRatio: pool.rebalanceDebtRatio,
          bonusRatio: pool.rebalanceBonusRatio,
        });
      }
      results[poolAddr] = poolResults;
    }
    return results;
  }

  public getBatchRebalanceShort(prices: Record<string, bigint>): Record<string, Array<ITickToBalance>> {
    const now = Date.now() / 1000;
    const results: Record<string, Array<ITickToBalance>> = {};
    for (const poolAddr of Object.keys(prices)) {
      const poolResults: Array<ITickToBalance> = [];
      const pool = this.shortPools[poolAddr];
      const lock = this.tickLock[poolAddr];
      for (let i = pool.ticks.length - 1; i >= 0; --i) {
        if (pool.ticks[i].debts === 0n) continue;
        if (lock && (lock[i - TICK_OFFSET] ?? 0) > now) continue; // ignore locked tick
        const rawColls = (pool.ticks[i].colls * E96) / pool.collIndex;
        const rawDebts = (pool.ticks[i].debts * pool.debtIndex) / E96;
        const price = prices[poolAddr];
        if (rawDebts * PRECISION * PRECISION >= pool.liquidateDebtRatio * rawColls * price) continue;
        if (rawDebts < 10n ** 9n) continue;
        if (rawDebts * PRECISION * PRECISION < pool.rebalanceDebtRatio * rawColls * price) break;
        poolResults.push({
          pool: poolAddr,
          token: pool.token,
          tick: i - TICK_OFFSET,
          price,
          rawColls,
          rawDebts,
          debtRatio: pool.rebalanceDebtRatio,
          bonusRatio: pool.rebalanceBonusRatio,
        });
      }
      results[poolAddr] = poolResults;
    }
    return results;
  }

  public getBatchLiquidate(prices: Record<string, bigint>): Record<string, Array<ITickToBalance>> {
    const now = Date.now() / 1000;
    const results: Record<string, Array<ITickToBalance>> = {};
    for (const poolAddr of Object.keys(prices)) {
      const poolResults: Array<ITickToBalance> = [];
      const pool = this.pools[poolAddr];
      const lock = this.tickLock[poolAddr];
      for (let i = pool.ticks.length - 1; i >= 0; --i) {
        if (pool.ticks[i].debts === 0n) continue;
        if (lock && (lock[i - TICK_OFFSET] ?? 0) > now) continue; // ignore locked tick
        const rawColls = (pool.ticks[i].colls * E96) / pool.collIndex;
        const rawDebts = (pool.ticks[i].debts * pool.debtIndex) / E96;
        const price = prices[poolAddr];
        if (rawDebts * PRECISION * PRECISION < pool.liquidateDebtRatio * rawColls * price) {
          if (rawDebts < 10n ** 9n) continue;
          break;
        }
        poolResults.push({
          pool: poolAddr,
          token: pool.token,
          tick: i - TICK_OFFSET,
          price,
          rawColls,
          rawDebts,
          debtRatio: pool.liquidateDebtRatio,
          bonusRatio: pool.liquidateBonusRatio,
        });
      }
      results[poolAddr] = poolResults;
    }
    return results;
  }

  public getBatchLiquidateShort(prices: Record<string, bigint>): Record<string, Array<ITickToBalance>> {
    const now = Date.now() / 1000;
    const results: Record<string, Array<ITickToBalance>> = {};
    for (const poolAddr of Object.keys(prices)) {
      const poolResults: Array<ITickToBalance> = [];
      const pool = this.shortPools[poolAddr];
      const lock = this.tickLock[poolAddr];
      for (let i = pool.ticks.length - 1; i >= 0; --i) {
        if (pool.ticks[i].debts === 0n) continue;
        if (lock && (lock[i - TICK_OFFSET] ?? 0) > now) continue; // ignore locked tick
        const rawColls = (pool.ticks[i].colls * E96) / pool.collIndex;
        const rawDebts = (pool.ticks[i].debts * pool.debtIndex) / E96;
        const price = prices[poolAddr];
        if (rawDebts * PRECISION * PRECISION < pool.liquidateDebtRatio * rawColls * price) {
          if (rawDebts < 10n ** 9n) continue;
          break;
        }
        poolResults.push({
          pool: poolAddr,
          token: pool.token,
          tick: i - TICK_OFFSET,
          price,
          rawColls,
          rawDebts,
          debtRatio: pool.liquidateDebtRatio,
          bonusRatio: pool.liquidateBonusRatio,
        });
      }
      results[poolAddr] = poolResults;
    }
    return results;
  }

  public lockTick(pool: string, tick: number, delay: number) {
    // lock tick for 30 seconds
    if (!this.tickLock[pool]) this.tickLock[pool] = {};
    this.tickLock[pool][tick] = Date.now() / 1000 + delay;
  }

  public lockPosition(pool: string, position: number, delay: number) {
    // lock position for 30 seconds
    if (!this.positionLock[pool]) this.positionLock[pool] = {};
    this.positionLock[pool][position] = Date.now() / 1000 + delay;
  }

  private async syncInternal(provider: JsonRpcProvider, fromBlock: number, latest: number) {
    // UpdateReservePool from PoolManager
    // UpdateLiquidationExpenseRatio from PoolManager
    // UpdateRedeemFeeRatio from PoolManager
    // UpdateTokenRate from PoolManager
    // UpdatePriceOracle from AaveFundingPool
    // UpdateRedeemStatus from AaveFundingPool
    // UpdateMaxRedeemRatioPerTick from AaveFundingPool
    // UpdateRebalanceRatios from AaveFundingPool
    // UpdateLiquidateRatios from AaveFundingPool
    // PositionSnapshot from AaveFundingPool
    // TickMovement from AaveFundingPool
    // DebtIndexSnapshot from AaveFundingPool
    // CollateralIndexSnapshot from AaveFundingPool
    const UpdateReservePoolTopicHash = PoolManagerInterface.getEvent("UpdateReservePool").topicHash;
    const UpdateLiquidationExpenseRatioTopicHash = PoolManagerInterface.getEvent(
      "UpdateLiquidationExpenseRatio",
    ).topicHash;
    const UpdateRedeemFeeRatioTopicHash = PoolManagerInterface.getEvent("UpdateRedeemFeeRatio").topicHash;
    const UpdateTokenRateTopicHash = PoolManagerInterface.getEvent("UpdateTokenRate").topicHash;
    const UpdatePriceOracleTopicHash = AaveFundingPoolInterface.getEvent("UpdatePriceOracle").topicHash;
    const UpdateRedeemStatusTopicHash = AaveFundingPoolInterface.getEvent("UpdateRedeemStatus").topicHash;
    const UpdateMaxRedeemRatioPerTickTopicHash =
      AaveFundingPoolInterface.getEvent("UpdateMaxRedeemRatioPerTick").topicHash;
    const UpdateRebalanceRatiosTopicHash = AaveFundingPoolInterface.getEvent("UpdateRebalanceRatios").topicHash;
    const UpdateLiquidateRatiosTopicHash = AaveFundingPoolInterface.getEvent("UpdateLiquidateRatios").topicHash;
    const PositionSnapshotTopicHash = AaveFundingPoolInterface.getEvent("PositionSnapshot").topicHash;
    const TickMovementTopicHash = AaveFundingPoolInterface.getEvent("TickMovement").topicHash;
    const DebtIndexSnapshotTopicHash = AaveFundingPoolInterface.getEvent("DebtIndexSnapshot").topicHash;
    const CollateralIndexSnapshotTopicHash = AaveFundingPoolInterface.getEvent("CollateralIndexSnapshot").topicHash;
    const Step = 500;
    for (; fromBlock <= latest; fromBlock += Step) {
      const toBlock = Math.min(fromBlock + Step - 1, latest);
      const logs = await provider.getLogs({
        fromBlock,
        toBlock,
        address: Object.keys(this.lastSyncBlock),
        topics: [
          [
            UpdateReservePoolTopicHash,
            UpdateLiquidationExpenseRatioTopicHash,
            UpdateRedeemFeeRatioTopicHash,
            UpdateTokenRateTopicHash,
            UpdatePriceOracleTopicHash,
            UpdateRedeemStatusTopicHash,
            UpdateMaxRedeemRatioPerTickTopicHash,
            UpdateRebalanceRatiosTopicHash,
            UpdateLiquidateRatiosTopicHash,
            PositionSnapshotTopicHash,
            TickMovementTopicHash,
            DebtIndexSnapshotTopicHash,
            CollateralIndexSnapshotTopicHash,
          ],
        ],
      });
      console.log(`Sync fromBlock[${fromBlock}] toBlock[${toBlock}], ${logs.length} logs`);
      for (const log of logs) {
        // ignore logs from previous sync
        if (log.blockNumber <= this.lastSyncBlock[log.address]) continue;

        if (log.topics[0] === UpdateReservePoolTopicHash) {
          const e = PoolManagerInterface.decodeEventLog("UpdateReservePool", log.data, log.topics);
          if (same(log.address, this.manager.address)) this.manager.reservePoolAddr = e.newReservePool;
          else this.shortPoolManager.reservePoolAddr = e.newReservePool;
          console.log(
            `${this.isLong(log.address) ? "Long" : "Short"}`,
            "UpdateReservePool:",
            `txHash[${log.transactionHash}]`,
            `oldReservePool[${e.oldReservePool}]`,
            `newReservePool[${e.newReservePool}]`,
          );
        } else if (log.topics[0] === UpdateLiquidationExpenseRatioTopicHash) {
          const e = PoolManagerInterface.decodeEventLog("UpdateLiquidationExpenseRatio", log.data, log.topics);
          if (same(log.address, this.manager.address)) this.manager.liquidationExpenseRatio = e.newRatio;
          else this.shortPoolManager.liquidationExpenseRatio = e.newRatio;
          console.log(
            `${this.isLong(log.address) ? "Long" : "Short"}`,
            "UpdateLiquidationExpenseRatio:",
            `txHash[${log.transactionHash}]`,
            `oldRatio[${ethers.formatUnits(e.oldRatio, 9)}]`,
            `newRatio[${ethers.formatUnits(e.newRatio, 9)}]`,
          );
        } else if (log.topics[0] === UpdateRedeemFeeRatioTopicHash) {
          const e = PoolManagerInterface.decodeEventLog("UpdateRedeemFeeRatio", log.data, log.topics);
          if (same(log.address, this.manager.address)) this.manager.redeemFeeRatio = e.newRatio;
          else this.shortPoolManager.redeemFeeRatio = e.newRatio;
          console.log(
            `${this.isLong(log.address) ? "Long" : "Short"}`,
            "UpdateRedeemFeeRatio:",
            `txHash[${log.transactionHash}]`,
            `oldRatio[${ethers.formatUnits(e.oldRatio, 9)}]`,
            `newRatio[${ethers.formatUnits(e.newRatio, 9)}]`,
          );
        } else if (log.topics[0] === UpdateTokenRateTopicHash) {
          const e = PoolManagerInterface.decodeEventLog("UpdateTokenRate", log.data, log.topics);
          if (same(log.address, this.manager.address)) this.manager.rateProvider[e.token] = [e.scalar, e.provider];
          else this.shortPoolManager.rateProvider[e.token] = [e.scalar, e.provider];
          console.log(
            `${this.isLong(log.address) ? "Long" : "Short"}`,
            "UpdateTokenRate:",
            `txHash[${log.transactionHash}]`,
            `token[${e.token}]`,
            `scalar[${e.scalar}]`,
            `provider[${e.provider}]`,
          );
        } else {
          let pool = this.pools[log.address];
          if (!pool) pool = this.shortPools[log.address];

          if (log.topics[0] === UpdatePriceOracleTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("UpdatePriceOracle", log.data, log.topics);
            pool.oracle = e.newOracle;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "UpdatePriceOracle:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `oldOracle[${e.oldOracle}]`,
              `newOracle[${e.newOracle}]`,
            );
          } else if (log.topics[0] === UpdateRedeemStatusTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("UpdateRedeemStatus", log.data, log.topics);
            pool.redeemStatus = e.status;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "UpdateRedeemStatus:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `redeemStatus[${e.status}]`,
            );
          } else if (log.topics[0] === UpdateMaxRedeemRatioPerTickTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("UpdateMaxRedeemRatioPerTick", log.data, log.topics);
            pool.maxRedeemRatioPerTick = e.ratio;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "UpdateMaxRedeemRatioPerTick:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `ratio[${ethers.formatUnits(e.ratio, 9)}]`,
            );
          } else if (log.topics[0] === UpdateRebalanceRatiosTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("UpdateRebalanceRatios", log.data, log.topics);
            pool.rebalanceDebtRatio = e.debtRatio;
            pool.rebalanceBonusRatio = e.bonusRatio;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "UpdateRebalanceRatios:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `debtRatio[${ethers.formatUnits(e.debtRatio, 18)}]`,
              `bonusRatio[${ethers.formatUnits(e.bonusRatio, 9)}]`,
            );
          } else if (log.topics[0] === UpdateLiquidateRatiosTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("UpdateLiquidateRatios", log.data, log.topics);
            pool.liquidateDebtRatio = e.debtRatio;
            pool.liquidateBonusRatio = e.bonusRatio;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "UpdateLiquidateRatios:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `debtRatio[${ethers.formatUnits(e.debtRatio, 18)}]`,
              `bonusRatio[${ethers.formatUnits(e.bonusRatio, 9)}]`,
            );
          } else if (log.topics[0] === PositionSnapshotTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("PositionSnapshot", log.data, log.topics);
            if (this.tickLock[log.address]) this.tickLock[log.address][Number(e.tick)] = 0;
            if (this.positionLock[log.address]) this.positionLock[log.address][Number(e.position)] = 0;
            const index = Number(e.position);
            let oldPosition = null;
            if (index === pool.positions.length) {
              pool.positions.push({
                tick: Number(e.tick),
                colls: e.collShares,
                debts: e.debtShares,
              });
            } else {
              oldPosition = pool.positions[index];
              const tick = oldPosition.tick + TICK_OFFSET;
              pool.ticks[tick].colls -= oldPosition.colls;
              pool.ticks[tick].debts -= oldPosition.debts;
              pool.positions[index] = {
                tick: Number(e.tick),
                colls: e.collShares,
                debts: e.debtShares,
              };
            }
            const newPosition = pool.positions[index];
            const tick = newPosition.tick + TICK_OFFSET;
            pool.ticks[tick].colls += newPosition.colls;
            pool.ticks[tick].debts += newPosition.debts;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "PositionSnapshot:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `position[${index}]`,
              `Tick[${oldPosition?.tick || "null"} -> ${newPosition.tick}]`,
              `Coll[${ethers.formatEther(oldPosition?.colls || 0n)} -> ${ethers.formatEther(newPosition.colls)}]`,
              `Debt[${ethers.formatEther(oldPosition?.debts || 0n)} -> ${ethers.formatEther(newPosition.debts)}]`,
            );
          } else if (log.topics[0] === TickMovementTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("TickMovement", log.data, log.topics);
            const lock = this.tickLock[log.address];
            if (lock) lock[Number(e.oldTick)] = 0;
            if (lock) lock[Number(e.newTick)] = 0;
            const oldTick = Number(e.oldTick) + TICK_OFFSET;
            const newTick = Number(e.newTick) + TICK_OFFSET;
            const collsBefore = pool.ticks[oldTick].colls;
            const debtsBefore = pool.ticks[oldTick].debts;
            pool.ticks[oldTick].colls = 0n;
            pool.ticks[oldTick].debts = 0n;
            for (let i = 0; i < pool.positions.length; ++i) {
              const position = pool.positions[i];
              if (position.tick === Number(e.oldTick)) {
                position.tick = Number(e.newTick);
                position.colls = (position.colls * e.collShares) / collsBefore;
                position.debts = (position.debts * e.debtShares) / debtsBefore;
                if (this.positionLock[log.address]) this.positionLock[log.address][i] = 0;
              }
            }
            pool.ticks[newTick].colls += e.collShares;
            pool.ticks[newTick].debts += e.debtShares;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "TickMovement:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `Tick[${e.oldTick} -> ${e.newTick}]`,
              `CollDelta[${ethers.formatEther(e.collShares)}]`,
              `DebtDelta[${ethers.formatEther(e.debtShares)}]`,
            );
          } else if (log.topics[0] === DebtIndexSnapshotTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("DebtIndexSnapshot", log.data, log.topics);
            pool.debtIndex = e.index;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "DebtIndexSnapshot:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `index[${e.index}]`,
            );
          } else if (log.topics[0] === CollateralIndexSnapshotTopicHash) {
            const e = AaveFundingPoolInterface.decodeEventLog("CollateralIndexSnapshot", log.data, log.topics);
            pool.collIndex = e.index;
            console.log(
              `${this.isLong(log.address) ? "Long" : "Short"}`,
              "CollateralIndexSnapshot:",
              `txHash[${log.transactionHash}]`,
              `pool[${log.address}]`,
              `index[${e.index}]`,
            );
          }
        }
      }
      for (const addr of Object.keys(this.lastSyncBlock)) {
        if (toBlock > this.lastSyncBlock[addr]) {
          this.lastSyncBlock[addr] = toBlock;
        }
      }
      this.saveState();
    }
  }

  private isLong(addr: string) {
    return this.manager.address === addr || this.pools[addr] !== undefined;
  }

  private loadState() {
    const filepath = path.join(this.statePath, "state.json");
    if (!fs.existsSync(filepath)) return;
    const state: StateInDisk = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    // override memory with local state
    if (state.LastSyncBlock) {
      Object.entries(state.LastSyncBlock).forEach(([addr, block]) => {
        this.lastSyncBlock[addr] = block;
      });
    } else if (state.LastSyncAt !== 0) {
      this.lastSyncBlock[POOL_MANAGER] = state.LastSyncAt;
      this.lastSyncBlock[WSTETH_POOL] = state.LastSyncAt;
      this.lastSyncBlock[WBTC_POOL] = state.LastSyncAt;
    } else {
      throw new Error("Invalid state file");
    }
    this.manager.address = state.PoolManager.Address;
    this.manager.reservePoolAddr = state.PoolManager.ReservePoolAddress;
    this.manager.redeemFeeRatio = BigInt(state.PoolManager.RedeemFeeRatio);
    this.manager.liquidationExpenseRatio = BigInt(state.PoolManager.LiquidationExpenseRatio);
    state.PoolManager.RateProvider.forEach(([token, scalar, provider]) => {
      this.manager.rateProvider[token] = [BigInt(scalar), provider];
    });
    state.Pools.forEach((pool) => {
      this.pools[pool.Address] = {
        token: pool.CollateralToken,
        oracle: pool.PriceOracle,
        collIndex: BigInt(pool.CollIndex),
        debtIndex: BigInt(pool.DebtIndex),
        redeemStatus: pool.RedeemStatus,
        maxRedeemRatioPerTick: BigInt(pool.MaxRedeemRatioPerTick),
        rebalanceDebtRatio: BigInt(pool.RebalanceDebtRatio),
        rebalanceBonusRatio: BigInt(pool.RebalanceBonusRatio),
        liquidateDebtRatio: BigInt(pool.LiquidateDebtRatio),
        liquidateBonusRatio: BigInt(pool.LiquidateBonusRatio),
        ticks: new Array(65536),
        positions: pool.Positions.map((position) => {
          return {
            tick: position.Tick,
            debts: BigInt(position.Debts),
            colls: BigInt(position.Colls),
          };
        }),
      };
      for (let i = 0; i < 65536; ++i) {
        this.pools[pool.Address].ticks[i] = {
          debts: 0n,
          colls: 0n,
        };
      }
      pool.Ticks.forEach((tick) => {
        this.pools[pool.Address].ticks[tick.Tick + TICK_OFFSET] = {
          debts: BigInt(tick.Debts),
          colls: BigInt(tick.Colls),
        };
      });
    });
    if (state.ShortPoolManager) {
      this.shortPoolManager.address = state.ShortPoolManager.Address;
      this.shortPoolManager.reservePoolAddr = state.ShortPoolManager.ReservePoolAddress;
      this.shortPoolManager.redeemFeeRatio = BigInt(state.ShortPoolManager.RedeemFeeRatio);
      this.shortPoolManager.liquidationExpenseRatio = BigInt(state.ShortPoolManager.LiquidationExpenseRatio);
      state.ShortPoolManager.RateProvider.forEach(([token, scalar, provider]) => {
        this.shortPoolManager.rateProvider[token] = [BigInt(scalar), provider];
      });
      state.ShortPools.forEach((pool) => {
        this.shortPools[pool.Address] = {
          token: pool.CollateralToken,
          oracle: pool.PriceOracle,
          collIndex: BigInt(pool.CollIndex),
          debtIndex: BigInt(pool.DebtIndex),
          redeemStatus: pool.RedeemStatus,
          maxRedeemRatioPerTick: BigInt(pool.MaxRedeemRatioPerTick),
          rebalanceDebtRatio: BigInt(pool.RebalanceDebtRatio),
          rebalanceBonusRatio: BigInt(pool.RebalanceBonusRatio),
          liquidateDebtRatio: BigInt(pool.LiquidateDebtRatio),
          liquidateBonusRatio: BigInt(pool.LiquidateBonusRatio),
          ticks: new Array(65536),
          positions: pool.Positions.map((position) => {
            return {
              tick: position.Tick,
              debts: BigInt(position.Debts),
              colls: BigInt(position.Colls),
            };
          }),
        };
        for (let i = 0; i < 65536; ++i) {
          this.shortPools[pool.Address].ticks[i] = {
            debts: 0n,
            colls: 0n,
          };
        }
        pool.Ticks.forEach((tick) => {
          this.shortPools[pool.Address].ticks[tick.Tick + TICK_OFFSET] = {
            debts: BigInt(tick.Debts),
            colls: BigInt(tick.Colls),
          };
        });
      });
    }
  }

  private saveState() {
    const filepath = path.join(this.statePath, "state.json");
    const state: StateInDisk = {
      LastSyncAt: 0,
      LastSyncBlock: this.lastSyncBlock,
      PoolManager: {
        Address: this.manager.address,
        ReservePoolAddress: this.manager.reservePoolAddr,
        RedeemFeeRatio: this.manager.redeemFeeRatio.toString(),
        LiquidationExpenseRatio: this.manager.liquidationExpenseRatio.toString(),
        RateProvider: Object.entries(this.manager.rateProvider).map(([token, [scalar, provider]]) => {
          return [token, scalar.toString(), provider];
        }),
      },
      ShortPoolManager: {
        Address: this.shortPoolManager.address,
        ReservePoolAddress: this.shortPoolManager.reservePoolAddr,
        RedeemFeeRatio: this.shortPoolManager.redeemFeeRatio.toString(),
        LiquidationExpenseRatio: this.shortPoolManager.liquidationExpenseRatio.toString(),
        RateProvider: Object.entries(this.shortPoolManager.rateProvider).map(([token, [scalar, provider]]) => {
          return [token, scalar.toString(), provider];
        }),
      },
      Pools: Object.entries(this.pools).map(([poolAddr, pool]) => {
        return {
          Address: poolAddr,
          CollateralToken: pool.token,
          PriceOracle: pool.oracle,
          CollIndex: pool.collIndex.toString(),
          DebtIndex: pool.debtIndex.toString(),
          RedeemStatus: pool.redeemStatus,
          MaxRedeemRatioPerTick: pool.maxRedeemRatioPerTick.toString(),
          RebalanceDebtRatio: pool.rebalanceDebtRatio.toString(),
          RebalanceBonusRatio: pool.rebalanceBonusRatio.toString(),
          LiquidateDebtRatio: pool.liquidateDebtRatio.toString(),
          LiquidateBonusRatio: pool.liquidateBonusRatio.toString(),
          Ticks: pool.ticks
            .map((tick, index) => {
              return {
                Tick: index - TICK_OFFSET,
                Debts: tick.debts.toString(),
                Colls: tick.colls.toString(),
              };
            })
            .filter((tick) => tick.Debts !== "0" || tick.Colls != "0"),
          Positions: pool.positions.map((position) => {
            return {
              Tick: position.tick,
              Debts: position.debts.toString(),
              Colls: position.colls.toString(),
            };
          }),
        };
      }),
      ShortPools: Object.entries(this.shortPools).map(([poolAddr, pool]) => {
        return {
          Address: poolAddr,
          CollateralToken: pool.token,
          PriceOracle: pool.oracle,
          CollIndex: pool.collIndex.toString(),
          DebtIndex: pool.debtIndex.toString(),
          RedeemStatus: pool.redeemStatus,
          MaxRedeemRatioPerTick: pool.maxRedeemRatioPerTick.toString(),
          RebalanceDebtRatio: pool.rebalanceDebtRatio.toString(),
          RebalanceBonusRatio: pool.rebalanceBonusRatio.toString(),
          LiquidateDebtRatio: pool.liquidateDebtRatio.toString(),
          LiquidateBonusRatio: pool.liquidateBonusRatio.toString(),
          Ticks: pool.ticks
            .map((tick, index) => {
              return {
                Tick: index - TICK_OFFSET,
                Debts: tick.debts.toString(),
                Colls: tick.colls.toString(),
              };
            })
            .filter((tick) => tick.Debts !== "0" || tick.Colls != "0"),
          Positions: pool.positions.map((position) => {
            return {
              Tick: position.tick,
              Debts: position.debts.toString(),
              Colls: position.colls.toString(),
            };
          }),
        };
      }),
    };
    fs.writeFileSync(filepath, JSON.stringify(state));
  }
}
