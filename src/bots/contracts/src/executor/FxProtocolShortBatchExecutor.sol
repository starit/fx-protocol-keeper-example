// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IMorpho } from "../interfaces/IMorpho.sol";
import { ICurveStableSwapNG } from "../interfaces/ICurveStableSwapNG.sol";
import { IFxUSDBasePool } from "../interfaces/IFxUSDBasePool.sol";
import { IPool } from "../interfaces/IPool.sol";
import { IShortPool } from "../interfaces/IShortPool.sol";
import { IMorphoFlashLoanCallback } from "../interfaces/IMorphoFlashLoanCallback.sol";
import { IShortPoolManager } from "../interfaces/IShortPoolManager.sol";

contract FxProtocolShortBatchExecutor is IMorphoFlashLoanCallback {
  using SafeERC20 for IERC20;

  address private immutable shortPoolManager;

  address private constant fxUSD = 0x085780639CC2cACd35E474e71f4d000e2405d8f6;

  address private constant wstETH = 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0;

  address private constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

  address private constant fxBASE = 0x65C9A641afCEB9C0E6034e558A319488FA0FA3be;

  address private constant USDC_fxUSD_POOL = 0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f;

  constructor(address _shortPoolManager) {
    shortPoolManager = _shortPoolManager;
  }

  function shortLiquidate(address pool, address token) external {
    require(pool != address(0), "pool cannot be zero address");
    uint256 balance = IERC20(token).balanceOf(address(this));
    IERC20(token).forceApprove(shortPoolManager, balance);
    IShortPoolManager(shortPoolManager).liquidate(pool, address(this), balance);
  }

  // borrow debt token, call rebalance or liquidate, swap fxUSD to wstETH
  function shortRebalanceOrLiquidate(address token, uint256 borrowAmount, bytes calldata data) external {
    IERC20(token).forceApprove(MORPHO, borrowAmount);
    IERC20(token).forceApprove(shortPoolManager, borrowAmount);
    IMorpho(MORPHO).flashLoan(token, borrowAmount, data);
  }

  function onMorphoFlashLoan(uint256 assets, bytes calldata userData) external {
    uint8 callType = uint8(bytes1(userData[0]));
    uint256 debtToRepay = assets; // fxUSD amount to repay
    // do rebalance or liquidate
    uint256 amountFxUSD;
    address pool;
    if (callType == 0) {
      (pool, amountFxUSD, assets) = _doRebalance(assets, userData);
    } else if (callType == 1) {
      (pool, amountFxUSD, assets) = _doLiquidate(assets, userData);
    }
    // swap fxUSD to debtToken
    address debtToken = IShortPool(pool).debtToken();
    uint256 debtTokenAmount = IERC20(debtToken).balanceOf(address(this));
    {
      (, address swapTarget, bytes memory swapData) = abi.decode(userData[1:], (address, address, bytes));
      IERC20(fxUSD).forceApprove(swapTarget, amountFxUSD);
      (bool success, ) = swapTarget.call(swapData);
      _popupRevertReason(success);
    }
    debtTokenAmount = IERC20(debtToken).balanceOf(address(this)) - debtTokenAmount;

    if (debtTokenAmount + assets < debtToRepay) revert("cannot repay");
  }

  function _doRebalance(uint256 maxAmounts, bytes calldata userData) internal returns (address, uint256, uint256) {
    (address pool, , ) = abi.decode(userData[1:], (address, address, bytes));
    (uint256 amountFxUSD, uint256 tokenUsed) = IShortPoolManager(shortPoolManager).rebalance(
      pool,
      address(this),
      maxAmounts
    );
    maxAmounts -= tokenUsed;
    return (pool, amountFxUSD, maxAmounts);
  }

  function _doLiquidate(uint256 maxAmounts, bytes calldata userData) internal returns (address, uint256, uint256) {
    (address pool, , ) = abi.decode(userData[1:], (address, address, bytes));
    (uint256 amountFxUSD, uint256 tokenUsed) = IShortPoolManager(shortPoolManager).liquidate(
      pool,
      address(this),
      maxAmounts
    );
    maxAmounts -= tokenUsed;
    return (pool, amountFxUSD, maxAmounts);
  }

  function _popupRevertReason(bool success) internal pure {
    // below lines will propagate inner error up
    if (!success) {
      // solhint-disable-next-line no-inline-assembly
      assembly {
        let ptr := mload(0x40)
        let size := returndatasize()
        returndatacopy(ptr, 0, size)
        revert(ptr, size)
      }
    }
  }
}
