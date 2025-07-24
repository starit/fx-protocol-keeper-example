import {
  ArbitrageProxy__factory,
  ERC20__factory,
  FxProtocolBatchExecutor__factory,
  FxProtocolBatchV2Executor__factory,
  FxProtocolExecutor__factory,
  FxProtocolLongBatchExecutor__factory,
  FxProtocolShortBatchExecutor__factory,
  FxUSDBasePool__factory,
  FxUSDRegeneracy__factory,
  ICurveStableSwapNG__factory,
  IPriceOracle__factory,
  IRateProvider__factory,
  MultiPathConverter__factory,
  PegKeeper__factory,
  PoolManager__factory,
} from "../../types";
import { encodeMultiPath, EthereumTokens, PATH_ENCODING } from "../../common";
import { ethers, ZeroAddress } from "ethers";

export const CurveStableSwapNGInterface = ICurveStableSwapNG__factory.createInterface();
export const FxUSDBasePoolInterface = FxUSDBasePool__factory.createInterface();
export const FxUSDRegeneracyInterface = FxUSDRegeneracy__factory.createInterface();
export const MultiPathConverterInterface = MultiPathConverter__factory.createInterface();
export const PoolManagerInterface = PoolManager__factory.createInterface();
export const PegKeeperInterface = PegKeeper__factory.createInterface();
export const PriceOracleInterface = IPriceOracle__factory.createInterface();
export const RateProviderInterface = IRateProvider__factory.createInterface();
export const FxProtocolBatchV2ExecutorInterface = FxProtocolBatchV2Executor__factory.createInterface();
export const FxProtocolShortBatchExecutorInterface = FxProtocolShortBatchExecutor__factory.createInterface();
export const FxProtocolLongBatchExecutorInterface = FxProtocolLongBatchExecutor__factory.createInterface();
export const ArbitrageProxyInterface = ArbitrageProxy__factory.createInterface();
export const ERC20Interface = ERC20__factory.createInterface();

export const FXUSD_BASE_POOL = "0x65C9A641afCEB9C0E6034e558A319488FA0FA3be";
export const PEG_KEEPER = "0x50562fe7e870420F5AAe480B7F94EB4ace2fcd70";
export const POOL_MANAGER = "0x250893CA4Ba5d05626C785e8da758026928FCD24";
export const SHORT_POOL_MANAGER = "0xaCDc0AB51178d0Ae8F70c1EAd7d3cF5421FDd66D";
export const WSTETH_POOL = "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8";
export const WSTETH_SHORT_POOL = "0x25707b9e6690B52C60aE6744d711cf9C1dFC1876";
export const WBTC_POOL = "0xAB709e26Fa6B0A30c119D8c55B887DeD24952473";
export const WBTC_SHORT_POOL = ZeroAddress;
export const RESERVE_POOL = "0xE93F5DD55eC9bdAbbba5eA88E4b4f3C253ee45Ed";
export const USDC_fxUSD_CURVE_POOL = "0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f";
export const MULTI_PATH_CONVERTER = "0x12AF4529129303D7FbD2563E242C4a2890525912";
export const ARBITRAGE_PROXY = "";

export const DefaultSwapRoute: {
  [poolAddr: string]: {
    encoding: bigint;
    routes: bigint[];
  };
} = {
  [WSTETH_POOL]: encodeMultiPath(
    // [[PATH_ENCODING["wstETH/WETH_V3Uni100"], PATH_ENCODING["WETH/USDC_V3Uni500"]]],
    [[PATH_ENCODING["wstETH/stETH_Lido"], PATH_ENCODING["stETH/WETH_CrvSB"], PATH_ENCODING["WETH/USDC_V3Uni500"]]],
    [100n],
  ),
  [WBTC_POOL]: encodeMultiPath([[PATH_ENCODING["WBTC/USDC_V3Uni3000"]]], [100n]),
  [WSTETH_SHORT_POOL]: encodeMultiPath(
    [[PATH_ENCODING["fxUSD/USDC_CrvSN193"], PATH_ENCODING["USDC/WETH_V3Uni500"], PATH_ENCODING["WETH/stETH_Lido"], PATH_ENCODING["stETH/wstETH_Lido"]]],
    [100n]
  ),
  [WBTC_SHORT_POOL]: encodeMultiPath([[PATH_ENCODING["fxUSD/USDC_CrvSN193"], PATH_ENCODING["USDC/WBTC_V3Uni3000"]]], [100n]),
};

export const PoolBaseToken: { [poolAddr: string]: string } = {
  [WSTETH_POOL]: EthereumTokens.wstETH.address,
  [WBTC_POOL]: EthereumTokens.WBTC.address,
  [WSTETH_SHORT_POOL]: EthereumTokens.wstETH.address,
  [WBTC_SHORT_POOL]: EthereumTokens.WBTC.address,
};

export const MaxDebtToLiquidate: { [poolAddr: string]: bigint } = {
  [WSTETH_POOL]: ethers.parseEther("1000000"),
  [WBTC_POOL]: ethers.parseEther("1000000"),
  [WSTETH_SHORT_POOL]: ethers.parseEther("250"),
  [WBTC_SHORT_POOL]: ethers.parseEther("10"),
};