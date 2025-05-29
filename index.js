const { ethers } = require('ethers');
const axios = require('axios');
require('dotenv').config();

// Import configuration
const { loadConfig } = require('./src/config/config');
const { loadWallets } = require('./src/utils/walletManager');

// Import services
const relayService = require('./src/services/relayService');
const flashloanService = require('./src/services/flashloanService');

// Import utilities
const { 
  initializeProvider, 
  approveToken, 
  checkTokenBalance, 
  getFlashloanFeePercentage,
  calculateRequiredTokens,
  getTokenDecimals,
  formatTokenAmount,
  estimateGas
} = require('./src/utils/ethereum');

// Constants
const TOKEN_ADDRESSES = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

// Main function
async function main() {
  try {
    console.log('🚀 Starting Relay Wash Trade Bot');
    
    // Load configuration
    const config = loadConfig();
    console.log('✅ Configuration loaded');
    
    // Load wallets
    const wallets = loadWallets();
    if (!wallets || wallets.length === 0) {
      throw new Error('No wallets found or configured');
    }
    console.log(`✅ Loaded ${wallets.length} wallet(s)`);
    
    // Initialize provider
    const provider = initializeProvider(config.RPC_URL);
    
    // Main execution loop
    while (true) {
      // Select a random wallet from active wallets
      const activeWallets = wallets.filter(wallet => wallet.active);
      if (activeWallets.length === 0) {
        throw new Error('No active wallets found');
      }
      
      const selectedWallet = activeWallets[Math.floor(Math.random() * activeWallets.length)];
      const wallet = new ethers.Wallet(selectedWallet.privateKey, provider);
      console.log(`🔑 Selected wallet: ${wallet.address}`);
      
      // Generate random amount within configured range
      const minAmount = ethers.utils.parseEther(config.MIN_AMOUNT_ETH);
      const maxAmount = ethers.utils.parseEther(config.MAX_AMOUNT_ETH);
      const range = maxAmount.sub(minAmount);
      const randomBigNumber = ethers.BigNumber.from(ethers.utils.randomBytes(32));
      const randomAmount = minAmount.add(randomBigNumber.mod(range));
      
      console.log(`💰 Swap amount: ${ethers.utils.formatEther(randomAmount)} ETH`);
      
      try {
        // Execute swap cycle
        await executeSwapCycle(wallet, randomAmount, config);
      } catch (error) {
        console.error(`❌ Error executing swap cycle: ${error.message}`);
      }
      
      // Wait for next execution
      const minInterval = config.REPEAT_INTERVAL_MIN * 60 * 1000; // Convert to milliseconds
      const maxInterval = config.REPEAT_INTERVAL_MAX * 60 * 1000;
      const waitTime = Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;
      
      console.log(`⏱️ Waiting ${waitTime / 1000} seconds until next execution`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  } catch (error) {
    console.error(`❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
}

// Execute a single swap cycle
async function executeSwapCycle(wallet, amount, config) {
  console.log('🔄 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Starting swap cycle with wallet ${wallet.address}`);
   
  const fromToken = TOKEN_ADDRESSES.WETH;
  const toToken = TOKEN_ADDRESSES.USDC;
  
  // Get token decimals for better display
  const fromTokenDecimals = await getTokenDecimals(wallet, fromToken);
  const toTokenDecimals = await getTokenDecimals(wallet, toToken);
  
  console.log(`💱 Token info loaded: WETH (${fromTokenDecimals} decimals), USDC (${toTokenDecimals} decimals)`);
  console.log(`💲 Initial amount: ${formatTokenAmount(amount, fromTokenDecimals)}`);
  
  // Step 1: Request inquiry from WETH to USDC
  console.log(`📊 Step 1: Requesting inquiry from WETH to USDC...`);
  const inquiry1 = await relayService.requestQuote({
    originChainId: 8453, // Base chain ID
    destinationChainId: 8453,
    originCurrency: fromToken,
    destinationCurrency: toToken,
    amount: amount.toString(),
    user: wallet.address,
    recipient: config.FLASHLOAN_CONTRACT,
    slippageTolerance: config.SLIPPAGE_TOLERANCE.toString()
  });
  inquiry1.data.steps = inquiry1.data.steps.filter(step => step.id == "swap");
  
  if (!inquiry1 || !inquiry1.data || !inquiry1.data.details) {
    throw new Error("Failed to get quote for WETH to USDC");
  }
  
  console.log(`📈 Quote received: ${inquiry1.data.details.currencyOut.amountFormatted} USDC`);
  
  // Step 2: Request inquiry from USDC back to WETH
  console.log(`📊 Step 2: Requesting inquiry from USDC back to WETH...`);
  const inquiry2 = await relayService.requestQuote({
    originChainId: 8453,
    destinationChainId: 8453,
    originCurrency: toToken,
    destinationCurrency: fromToken,
    amount: inquiry1.data.details.currencyOut.minimumAmount,
    user: config.FLASHLOAN_CONTRACT,
    recipient: wallet.address,
    slippageTolerance: config.SLIPPAGE_TOLERANCE.toString()
  });
  
  if (!inquiry2 || !inquiry2.data || !inquiry2.data.details) {
    throw new Error("Failed to get quote for USDC to WETH");
  }
  
  // Calculate the shortfall
  const initialAmount = ethers.BigNumber.from(amount);
  const returnedAmount = ethers.BigNumber.from(inquiry2.data.details.currencyOut.minimumAmount);
  const shortfallAmount = initialAmount.sub(returnedAmount);
  
  console.log(`💵 Initial amount: ${formatTokenAmount(initialAmount, fromTokenDecimals)} (${initialAmount.toString()} raw)`);
  console.log(`💵 Returned amount: ${formatTokenAmount(returnedAmount, fromTokenDecimals)} (${returnedAmount.toString()} raw)`);
  console.log(`🔄 Shortfall amount: ${formatTokenAmount(shortfallAmount, fromTokenDecimals)} (${shortfallAmount.toString()} raw)`);
  
  // Get flashloan fee percentage
  const feePercentage = await getFlashloanFeePercentage(wallet, config.FLASHLOAN_CONTRACT);
  console.log(`💸 Flashloan fee percentage: ${feePercentage}%`);
  
  // Calculate total required tokens (shortfall + fee)
  const requiredTokensInfo = calculateRequiredTokens(ethers.BigNumber.from(amount), shortfallAmount, feePercentage, fromTokenDecimals);
  console.log(`💰 Total required: ${requiredTokensInfo.formatted} (including fee)`);
  
  // Check if user has enough tokens
  const userBalanceInfo = await checkTokenBalance(wallet, fromToken);
  console.log(`💳 User balance: ${userBalanceInfo.formatted} WETH`);
  
  // Validate if user has enough tokens
  if (userBalanceInfo.balance.lt(requiredTokensInfo.required)) {
    console.error('❌ Insufficient balance:');
    console.error(` Required: ${requiredTokensInfo.formatted}`);
    console.error(` Available: ${userBalanceInfo.formatted}`);
    console.error(` Missing: ${formatTokenAmount(requiredTokensInfo.required.sub(userBalanceInfo.balance), fromTokenDecimals)}`);
    throw new Error("Insufficient balance to cover shortfall and fee");
  }
  
  console.log('✅ Sufficient balance to cover shortfall and fee');
  
  // If there's a shortfall, we need to approve the token for the flashloan contract
  if (shortfallAmount.gt(0)) {
    console.log(`🔑 Need to approve token for the flashloan contract to handle ${formatTokenAmount(shortfallAmount, fromTokenDecimals)} shortfall`);
    const approvalSuccess = await approveToken(wallet, fromToken, config.FLASHLOAN_CONTRACT);
    if (!approvalSuccess) {
      throw new Error("Failed to approve token for flashloan contract");
    }
  }
  
  // Step 3: Build payload for flashloan
  console.log('🔄 Step 3: Preparing flashloan transaction...');
  
  // We need to borrow the initial amount
  const amountBorrow = amount;
  console.log(`🏦 Setting borrow amount to: ${formatTokenAmount(amountBorrow, fromTokenDecimals)}`);
  
  // Generate flashloan payload
  const flashloanPayload = await flashloanService.generatePayload(
    amountBorrow,
    requiredTokensInfo.fee,
    inquiry1.data.steps[0].items[0].data.data,
    inquiry2.data.steps[0].items[0].data.data,
    config.FLASHLOAN_CONTRACT,
    wallet.address,
    inquiry1.data.steps[0].items[0].data.to,
    inquiry2.data.steps[0].items[0].data.to,
    fromToken
  );
  
  // Step 4: Estimate gas for the transaction
  console.log('🔍 Step 4: Estimating gas for flashloan transaction...');
  
  try {
    const gasEstimate = await estimateGas(
      wallet,
      config.FLASHLOAN_CONTRACT,
      fromToken,
      amountBorrow,
      flashloanPayload
    );
    if (gasEstimate === 0) {
      return console.log("Gas estimate failed");
    }
    
    console.log(`⛽ Estimated gas: ${gasEstimate.toString()}`);
    
    // Step 5: Execute the flashloan
    console.log('💸 Step 5: Executing flashloan transaction...');
    
    const tx = await flashloanService.executeFlashloan(
      wallet,
      config.FLASHLOAN_CONTRACT,
      fromToken,
      amountBorrow,
      flashloanPayload
    );
    
    console.log(`✅ Transaction submitted: ${tx.hash}`);
    
    // Wait for transaction confirmation
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`✅ Gas used: ${receipt.gasUsed.toString()}`);
    
    console.log('✅ Swap cycle completed successfully!');
  } catch (error) {
    console.error(`❌ Gas estimation failed: ${error.message}`);
    console.error('❌ Transaction would fail if executed. Aborting.');
    throw new Error(`Transaction would fail: ${error.message}`);
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// Start the bot
if (require.main === module) {
  main().catch(error => {
    console.error(`❌ Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, executeSwapCycle };
