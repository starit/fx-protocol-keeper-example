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

contract FxProtocolLongBatchExecutor is IMorphoFlashLoanCallback {
  using SafeERC20 for IERC20;

  address private immutable shortPoolManager;

  address private constant fxUSD = 0x085780639CC2cACd35E474e71f4d000e2405d8f6;

  address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

  address private constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

  address private constant fxBASE = 0x65C9A641afCEB9C0E6034e558A319488FA0FA3be;

  address private constant USDC_fxUSD_POOL = 0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f;

  constructor(address _shortPoolManager) {
    shortPoolManager = _shortPoolManager;
  }

  function rebalanceOrLiquidateV2WithCreditNote(uint256 borrowAmount, bytes calldata data) external {
    require(borrowAmount > 0, "borrowAmount must be greater than 0");
    IERC20(USDC).forceApprove(MORPHO, borrowAmount);
    IMorpho(MORPHO).flashLoan(USDC, borrowAmount, data);
  }

  function onMorphoFlashLoan(uint256 assets, bytes calldata userData) external {
    uint8 callType = uint8(bytes1(userData[0]));
    uint8 useFxUSD = callType & 1;
    callType >>= 1;
    address tokenToUse = USDC;
    uint256 usdcToRepay = assets;
    // swap USDC to base if needed
    if (useFxUSD == 1) {
      assets = ICurveStableSwapNG(USDC_fxUSD_POOL).exchange(0, 1, assets, 0);
      tokenToUse = fxUSD;
    }
    // do rebalance or liquidate
    uint256 amountBase;
    address pool;
    if (callType == 0) {
      (pool, amountBase, assets) = _doRebalance(tokenToUse, assets, userData);
    } else if (callType == 1) {
      (pool, amountBase, assets) = _doLiquidate(tokenToUse, assets, userData);
    }
    // swap base to USDC
    uint256 usdcAmount = IERC20(USDC).balanceOf(address(this));
    {
      (, address swapTarget, bytes memory swapData) = abi.decode(userData[1:], (address, address, bytes));
      IERC20(IPool(pool).collateralToken()).forceApprove(swapTarget, amountBase);
      if (amountBase > 0) {
        (bool success, ) = swapTarget.call(swapData);
        _popupRevertReason(success);
      }
    }
    usdcAmount = IERC20(USDC).balanceOf(address(this)) - usdcAmount;
    // check if we have credit note
    address shortPool = IPool(pool).counterparty();
    if (shortPool != address(0)) {
      address creditNote = IShortPool(shortPool).creditNote();
      uint256 balance = IERC20(creditNote).balanceOf(address(this));
      if (balance > 0) {
        IERC20(creditNote).forceApprove(shortPoolManager, balance);
        balance = IShortPoolManager(shortPoolManager).redeemByCreditNote(shortPool, balance, 0);
        // swap fxUSD to USDC
        usdcAmount += ICurveStableSwapNG(USDC_fxUSD_POOL).exchange(1, 0, balance, 0);
      }
    }
    // swap rest fxUSD to USDC if needed
    if (usdcAmount < usdcToRepay && useFxUSD == 1 && assets > 0) {
      usdcAmount += ICurveStableSwapNG(USDC_fxUSD_POOL).exchange(1, 0, assets, 0);
    }
    if (usdcAmount < usdcToRepay) revert("cannot repay");
  }

  function _doRebalance(
    address tokenToUse,
    uint256 maxAmounts,
    bytes calldata userData
  ) internal returns (address, uint256, uint256) {
    (address pool, , ) = abi.decode(userData[1:], (address, address, bytes));
    address collateralToken = IPool(pool).collateralToken();
    uint256 balance = IERC20(collateralToken).balanceOf(address(this));
    (uint256 tokenUsed, uint256 amountBase) = IFxUSDBasePool(fxBASE).rebalance(pool, tokenToUse, maxAmounts, 0);
    balance = IERC20(collateralToken).balanceOf(address(this)) - balance;
    if (balance < amountBase) amountBase = balance;
    maxAmounts -= tokenUsed;
    return (pool, amountBase, maxAmounts);
  }

  function _doLiquidate(
    address tokenToUse,
    uint256 maxAmounts,
    bytes calldata userData
  ) internal returns (address, uint256, uint256) {
    (address pool, , ) = abi.decode(userData[1:], (address, address, bytes));
    address collateralToken = IPool(pool).collateralToken();
    uint256 balance = IERC20(collateralToken).balanceOf(address(this));
    (uint256 tokenUsed, uint256 amountBase) = IFxUSDBasePool(fxBASE).liquidate(pool, tokenToUse, maxAmounts, 0);
    balance = IERC20(collateralToken).balanceOf(address(this)) - balance;
    if (balance < amountBase) amountBase = balance;
    maxAmounts -= tokenUsed;
    return (pool, amountBase, maxAmounts);
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
