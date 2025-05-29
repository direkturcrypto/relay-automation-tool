const { ethers } = require('ethers');
require('dotenv').config();

/**
 * Ethereum utility functions
 */
class EthereumUtils {
  /**
   * Initialize provider
   * @param {string} rpcUrl - RPC URL
   * @returns {Provider} Ethers.js provider
   */
  initializeProvider(rpcUrl) {
    try {
      console.log(`🔌 Initializing provider with RPC URL: ${rpcUrl}`);
      return new ethers.providers.JsonRpcProvider(rpcUrl);
    } catch (error) {
      console.error(`❌ Error initializing provider: ${error.message}`);
      throw error;
    }
  }

  /**
   * Approve token for spending
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {string} tokenAddress - Token address
   * @param {string} spenderAddress - Spender address
   * @param {Object} options - Optional transaction parameters
   * @returns {Promise<boolean>} Success status
   */
  async approveToken(wallet, tokenAddress, spenderAddress, options = {}) {
    try {
      console.log(`🔐 Approving token ${tokenAddress} for spender ${spenderAddress}...`);
      
      // Create token contract instance
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'],
        wallet
      );
      
      // Check current allowance
      const currentAllowance = await tokenContract.allowance(wallet.address, spenderAddress);
      console.log(`🔍 Current allowance: ${ethers.utils.formatEther(currentAllowance)} tokens`);
      
      // If already approved, return true
      if (currentAllowance.gt(ethers.constants.Zero)) {
        console.log(`✅ Token already approved for spending`);
        return true;
      }
      
      // Set max approval amount
      const maxApproval = ethers.constants.MaxUint256;
      
      // Build transaction parameters
      const txParams = {
        gasLimit: 100000, // Gas limit for approval
        ...options // Include any additional options passed (like gasPrice)
      };
      
      // Send approval transaction
      const tx = await tokenContract.approve(spenderAddress, maxApproval, txParams);
      console.log(`📝 Approval transaction submitted: ${tx.hash}`);
      
      // Wait for transaction confirmation
      const receipt = await tx.wait();
      console.log(`✅ Approval confirmed in block ${receipt.blockNumber}`);
      
      return true;
    } catch (error) {
      console.error(`❌ Error approving token: ${error.message}`);
      return false;
    }
  }

  /**
   * Check token balance
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {string} tokenAddress - Token address
   * @returns {Promise<Object>} Balance information
   */
  async checkTokenBalance(wallet, tokenAddress) {
    try {
      console.log(`💰 Checking token balance for ${wallet.address}...`);
      
      // Create token contract instance
      const tokenContract = new ethers.Contract(
        tokenAddress,
        require('../../abis/erc20.json'),
        wallet
      );
      
      // Get token details
      const symbol = await tokenContract.symbol();
      const decimals = await tokenContract.decimals();
      const balance = await tokenContract.balanceOf(wallet.address);
      
      const formatted = ethers.utils.formatUnits(balance, decimals);
      
      console.log(`💵 Balance: ${formatted} ${symbol}`);
      
      return {
        balance,
        formatted,
        symbol,
        decimals
      };
    } catch (error) {
      console.error(`❌ Error checking token balance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get flashloan fee percentage
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {string} flashloanContractAddress - Flashloan contract address
   * @returns {Promise<number>} Fee percentage
   */
  async getFlashloanFeePercentage(wallet, flashloanContractAddress) {
    try {
      console.log(`💸 Getting flashloan fee percentage...`);
      
      // Create flashloan contract instance
      const flashloanContract = new ethers.Contract(
        flashloanContractAddress,
        require('../../abis/flashloan.json'),
        wallet
      );
      
      // Get fee percentage
      const feePercentage = await flashloanContract.FEE_PRECENTAGE();
      
      // Convert from basis points to percentage (e.g., 30 -> 0.3%)
      const percentage = feePercentage / 100;
      
      console.log(`📊 Flashloan fee percentage: ${percentage}%`);
      
      return percentage;
    } catch (error) {
      console.error(`❌ Error getting flashloan fee percentage: ${error.message}`);
      // Default to 0.3% if error
      console.log(`⚠️ Using default fee percentage: 0.3%`);
      return 0.3;
    }
  }

  /**
   * Calculate required tokens for flashloan (shortfall + fee)
   * @param {BigNumber} shortfallAmount - Shortfall amount
   * @param {number} feePercentage - Fee percentage
   * @param {number} decimals - Token decimals
   * @returns {Object} Required tokens information
   */
  calculateRequiredTokens(borrowedAmount,shortfallAmount, feePercentage, decimals) {
    try {
      console.log(`🧮 Calculating required tokens...`);
      
      // Calculate fee amount
      const feeAmount = borrowedAmount.mul(Math.floor(feePercentage * 100)).div(10000);
      
      // Add buffer to shortfall (configurable percentage)
      const bufferPercentage = parseFloat(process.env.SHORTFALL_BUFFER_PERCENTAGE || '5');
      const bufferAmount = shortfallAmount.mul(Math.floor(bufferPercentage * 100)).div(10000);
      
      // Calculate total required
      const totalRequired = shortfallAmount.add(feeAmount).add(bufferAmount);
      
      const formattedShortfall = ethers.utils.formatUnits(shortfallAmount, decimals);
      const formattedFee = ethers.utils.formatUnits(feeAmount, decimals);
      const formattedBuffer = ethers.utils.formatUnits(bufferAmount, decimals);
      const formattedTotal = ethers.utils.formatUnits(totalRequired, decimals);
      
      console.log(`📊 Shortfall: ${formattedShortfall}`);
      console.log(`📊 Fee: ${formattedFee} (${feePercentage}%)`);
      console.log(`📊 Buffer: ${formattedBuffer} (${bufferPercentage}%)`);
      console.log(`📊 Total required: ${formattedTotal}`);
      
      return {
        shortfall: shortfallAmount,
        fee: feeAmount,
        buffer: bufferAmount,
        required: totalRequired,
        formattedShortfall,
        formattedFee,
        formattedBuffer,
        formatted: formattedTotal
      };
    } catch (error) {
      console.error(`❌ Error calculating required tokens: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get token decimals
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {string} tokenAddress - Token address
   * @returns {Promise<number>} Token decimals
   */
  async getTokenDecimals(wallet, tokenAddress) {
    try {
      // Create token contract instance
      const tokenContract = new ethers.Contract(
        tokenAddress,
        require('../../abis/erc20.json'),
        wallet
      );
      
      // Get decimals
      const decimals = await tokenContract.decimals();
      
      return decimals;
    } catch (error) {
      console.error(`❌ Error getting token decimals: ${error.message}`);
      // Default to 18 decimals if error
      return 18;
    }
  }

  /**
   * Format token amount with proper decimals
   * @param {BigNumber|string} amount - Token amount
   * @param {number} decimals - Token decimals
   * @returns {string} Formatted amount
   */
  formatTokenAmount(amount, decimals) {
    try {
      return ethers.utils.formatUnits(amount, decimals);
    } catch (error) {
      console.error(`❌ Error formatting token amount: ${error.message}`);
      return amount.toString();
    }
  }

  /**
   * Estimate gas for flashloan transaction
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {string} flashloanContractAddress - Flashloan contract address
   * @param {string} tokenAddress - Token address
   * @param {BigNumber} amount - Amount to borrow
   * @param {string} userData - Encoded user data
   * @returns {Promise<BigNumber>} Estimated gas
   */
  async estimateGas(wallet, flashloanContractAddress, tokenAddress, amount, userData) {
    try {
      console.log(`⛽ Estimating gas for flashloan transaction...`);
      
      // Create flashloan contract instance
      const flashloanContract = new ethers.Contract(
        flashloanContractAddress,
        require('../../abis/flashloan.json'),
        wallet
      );
      
      // Estimate gas
      const gasEstimate = await flashloanContract.estimateGas.utang(
        [tokenAddress], // tokens array
        [amount], // amounts array
        userData // user data
      );
      
      // Add 20% buffer to gas estimate
      const gasWithBuffer = gasEstimate.mul(120).div(100);
      
      console.log(`⛽ Base gas estimate: ${gasEstimate.toString()}`);
      console.log(`⛽ Gas estimate with 20% buffer: ${gasWithBuffer.toString()}`);
      
      return gasWithBuffer;
    } catch (error) {
      console.error(`❌ Error estimating gas: ${error.reason || error.shortMessage}`);
      return 0;
    }
  }

  /**
   * Transfer tokens from one address to another using transferFrom
   * @param {Wallet} wallet - Ethers.js wallet (must have allowance)
   * @param {string} tokenAddress - ERC20 token address
   * @param {string} from - Source address
   * @param {string} to - Destination address
   * @param {BigNumber|string} amount - Amount to transfer
   * @returns {Promise<boolean>} Success status
   */
  async transferFromToken(wallet, tokenAddress, from, to, amount) {
    try {
      console.log(`🔄 transferFrom ${amount} tokens from ${from} to ${to} on token ${tokenAddress}`);
      const tokenContract = new ethers.Contract(
        tokenAddress,
        require('../../abis/erc20.json'),
        wallet
      );
      const tx = await tokenContract.transferFrom(from, to, amount, { gasLimit: 100000 });
      console.log(`📝 transferFrom tx submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ transferFrom confirmed in block ${receipt.blockNumber}`);
      return true;
    } catch (error) {
      console.error(`❌ Error in transferFrom: ${error.message}`);
      return false;
    }
  }
}

module.exports = new EthereumUtils();
