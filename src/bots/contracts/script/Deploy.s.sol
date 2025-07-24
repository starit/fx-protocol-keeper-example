// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// solhint-disable no-console

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { ArbitrageProxy } from "../src/ArbitrageProxy.sol";
import { FxProtocolLongBatchExecutor } from "../src/executor/FxProtocolLongBatchExecutor.sol";
import { FxProtocolShortBatchExecutor } from "../src/executor/FxProtocolShortBatchExecutor.sol";
import { FxProtocolBatchV2Executor } from "../src/executor/FxProtocolBatchV2Executor.sol";

// solhint-disable state-visibility
// solhint-disable var-name-mixedcase

contract Deploy is Script {
  uint256 PRIVATE_KEY = vm.envUint("PRIVATE_KEY");

  address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address private constant fxUSD = 0x085780639CC2cACd35E474e71f4d000e2405d8f6;
  address private constant PoolManager = 0x250893CA4Ba5d05626C785e8da758026928FCD24;
  address private constant FxBase = 0x65C9A641afCEB9C0E6034e558A319488FA0FA3be;
  address private constant USDC_fxUSD_POOL = 0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f;
  address private constant wstETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
  address private constant SHORT_POOL_MANAGER = 0xaCDc0AB51178d0Ae8F70c1EAd7d3cF5421FDd66D; // Replace with the correct address

  function run() external {
    bytes32 salt = keccak256(abi.encode(vm.envString("SALT")));
    vm.startBroadcast(PRIVATE_KEY);
    address deployer = vm.addr(PRIVATE_KEY);
    console.log("deployer: ", deployer);

    address[] memory _managers = new address[](1);
    address[] memory _operators = new address[](1);
    _managers[0] = deployer;
    _operators[0] = deployer;

    ArbitrageProxy proxy = new ArbitrageProxy{ salt: salt }(_managers, _operators);
    logAddress("ArbitrageProxy", address(proxy));

    FxProtocolBatchV2Executor batchV2Executor = new FxProtocolBatchV2Executor{ salt: salt }();
    logAddress("FxProtocolBatchV2Executor", address(batchV2Executor));

    FxProtocolLongBatchExecutor longbatchExecutor = new FxProtocolLongBatchExecutor{ salt: salt }(SHORT_POOL_MANAGER);
    FxProtocolShortBatchExecutor shortbatchExecutor = new FxProtocolShortBatchExecutor{ salt: salt }(
      SHORT_POOL_MANAGER
    );

    logAddress("FxProtocolLongBatchExecutor", address(longbatchExecutor));
    logAddress("FxProtocolShortBatchExecutor", address(shortbatchExecutor));

    proxy.updateImpl(FxProtocolBatchV2Executor.liquidateV2.selector, address(batchV2Executor));
    proxy.updateImpl(FxProtocolBatchV2Executor.rebalanceOrLiquidateV2.selector, address(batchV2Executor));

    proxy.updateImpl(
      FxProtocolLongBatchExecutor.rebalanceOrLiquidateV2WithCreditNote.selector,
      address(longbatchExecutor)
    );

    proxy.updateImpl(FxProtocolShortBatchExecutor.shortLiquidate.selector, address(shortbatchExecutor));
    proxy.updateImpl(FxProtocolShortBatchExecutor.shortRebalanceOrLiquidate.selector, address(shortbatchExecutor));

    // maximum approve:
    // + USDC,fxUSD to USDC_fxUSD_POOL
    // + fxUSD, USDC to PoolManager and fxBASE
    proxy.rescue(fxUSD, 0, abi.encodeCall(IERC20.approve, (USDC_fxUSD_POOL, type(uint256).max)));
    proxy.rescue(USDC, 0, abi.encodeCall(IERC20.approve, (USDC_fxUSD_POOL, type(uint256).max)));
    proxy.rescue(fxUSD, 0, abi.encodeCall(IERC20.approve, (PoolManager, type(uint256).max)));
    proxy.rescue(wstETH, 0, abi.encodeCall(IERC20.approve, (SHORT_POOL_MANAGER, type(uint256).max)));
    proxy.rescue(USDC, 0, abi.encodeCall(IERC20.approve, (FxBase, type(uint256).max)));
    proxy.rescue(fxUSD, 0, abi.encodeCall(IERC20.approve, (FxBase, type(uint256).max)));

    vm.stopBroadcast();
  }

  function logAddress(string memory name, address addr) internal pure {
    console.log(string(abi.encodePacked(name, "=", vm.toString(address(addr)))));
  }
}
