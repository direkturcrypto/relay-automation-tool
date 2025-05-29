const { ethers } = require('ethers');

/**
 * Service for handling flashloan operations
 */
class FlashloanService {
  /**
   * Generate payload for flashloan transaction
   * @param {BigNumber} amountBorrow - Amount to borrow
   * @param {BigNumber} shortfallAmount - Shortfall amount
   * @param {string} swapData1 - Data for first swap (WETH to USDC)
   * @param {string} swapData2 - Data for second swap (USDC to WETH)
   * @param {string} flashloanContract - Flashloan contract address
   * @param {string} userAddress - User wallet address
   * @param {string} router1 - First router address
   * @param {string} router2 - Second router address
   * @param {string} tokenAddress - Token address to transfer (optional)
   * @returns {Promise<string>} Encoded flashloan data
   */
  async generatePayload(
    amountBorrow,
    feeAmount,
    swapData1,
    swapData2,
    flashloanContract,
    userAddress,
    router1,
    router2,
    tokenAddress
  ) {
    try {
      console.log(`🔧 Generating flashloan payload...`);
      
      // Create ERC20 transferFrom function selector and parameters
      // transferFrom(address,address,uint256) function signature
      const transferFromSelector = "0x23b872dd";
      const transferFromParams = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint256"],
        [userAddress, flashloanContract, feeAmount]
      );
      const transferFromData = transferFromSelector + transferFromParams.substring(2); // remove 0x from params

      // totally repay the flashloan
      const repayParams = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint256"],
        [userAddress, flashloanContract, amountBorrow]
      );
      const repayData = transferFromSelector + repayParams.substring(2); // remove 0x from params
      
      // Create transaction array for flashloan
      const transactions = [
        // First transaction: Transfer shortfall from user to flashloan contract using transferFrom
        {
          from: flashloanContract,
          to: tokenAddress, // Token address
          amount: "0", // 0 amount because we're calling a function
          data: transferFromData // transferFrom function call data
        },
        // Second transaction: First swap (WETH to USDC)
        {
          from: flashloanContract,
          to: router1,
          amount: "0",
          data: swapData1
        },
        // Third transaction: Second swap (USDC to WETH)
        {
          from: flashloanContract,
          to: router2,
          amount: "0",
          data: swapData2
        },
        // Fourth transaction: Repay the flashloan
        {
          from: flashloanContract,
          to: tokenAddress,
          amount: "0",
          data: repayData
        }
      ];
      
      console.log(`📦 Created ${transactions.length} transactions for flashloan payload`);
      
      // Encode the transactions for the flashloan contract
      const abiCoder = new ethers.utils.AbiCoder();
      const encodedData = abiCoder.encode(
        [
          {
            components: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'data', type: 'bytes' }
            ],
            name: 'txn',
            type: 'tuple[]'
          }
        ],
        [transactions]
      );
      
      return encodedData;
    } catch (error) {
      console.error(`❌ Error generating flashloan payload: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Execute a flashloan transaction
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {string} flashloanContractAddress - Flashloan contract address
   * @param {string} tokenAddress - Token address to borrow
   * @param {BigNumber} amount - Amount to borrow
   * @param {string} userData - Encoded user data for flashloan
   * @returns {Promise<TransactionResponse>} Transaction response
   */
  async executeFlashloan(
    wallet,
    flashloanContractAddress,
    tokenAddress,
    amount,
    userData
  ) {
    try {
      console.log(`💸 Executing flashloan for ${ethers.utils.formatEther(amount)} WETH...`);
      
      // Create contract instance
      const flashloanContract = new ethers.Contract(
        flashloanContractAddress,
        require('../../abis/flashloan.json'),
        wallet
      );
      
      // Call the utang function (flashloan)
      const tx = await flashloanContract.utang(
        [tokenAddress], // tokens array
        [amount], // amounts array
        userData, // user data
        {
          gasPrice: 0.015 * 1e9 // Set a reasonable gas limit
        }
      );
      
      console.log(`📝 Flashloan transaction submitted: ${tx.hash}`);
      return tx;
    } catch (error) {
      console.error(`❌ Error executing flashloan: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new FlashloanService();
