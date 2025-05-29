const { ethers } = require('ethers');
const axios = require('axios');
require('dotenv').config();

// Import configuration
const { loadConfig } = require('../src/config/config');
const { loadWallets } = require('../src/utils/walletManager');

// Import services
const bridgeService = require('../src/services/bridgeService');

// Import utilities
const { 
  initializeProvider, 
  approveToken, 
  checkTokenBalance, 
  formatTokenAmount,
} = require('../src/utils/ethereum');

// Minimum bridge amounts
const MIN_BRIDGE_AMOUNTS = {
  WETH: ethers.utils.parseEther("0.001"),  // 0.001 ETH/WETH
  USDC: ethers.utils.parseUnits("1", 6),   // 1 USDC (6 decimals)
  ETH: ethers.utils.parseEther("0.001"),   // 0.001 ETH
  DEFAULT: ethers.utils.parseEther("0.001") // Default min amount
};

// Gas amount to bridge when running low
const GAS_BRIDGE_AMOUNT = ethers.utils.parseEther("0.001"); // 0.001 ETH

// Target tokens mapping
const TARGET_TOKENS = {
  WETH: "USDC",  // If WETH is found, bridge to USDC
  USDC: "WETH"   // If USDC is found, bridge to WETH
};

// Chain IDs
const CHAIN_IDS = {
  BASE: 8453,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  LINEA: 59144
};

// 1inch API Key
const ONEINCH_API_KEY = "8BaadOaqTnEslDlP7if4OZu7ilHZST9G";

// Maximum gas price in gwei
const MAX_GAS_PRICE_GWEI = 0.1;

/**
 * Get swap quote from 1inch API
 * @param {string} account - User wallet address
 * @param {string} receiver - Receiver address (usually same as account)
 * @param {string} from - Source token address
 * @param {string} to - Destination token address
 * @param {string} amount - Amount to swap in wei
 * @param {number} chainId - Chain ID to execute swap on
 * @returns {Promise<Object>} Swap data
 */
async function getQuote(account, receiver, from, to, amount, chainId) {
  try {
    console.log(`🔄 Getting 1inch swap quote on chain ${chainId}...`);
    console.log(`🔍 Parameters: from=${from}, to=${to}, amount=${amount.toString()}`);
    
    const config = {
      url: `https://api.1inch.dev/swap/v6.0/${chainId}/swap`,
      params: {
        src: from,
        dst: to,
        amount: amount.toString(),
        from: account,
        receiver: receiver,
        fee: 1,
        slippage: 0.1,
        referrer: "0x00000015C1106FFDFC6e0B6eDB54176bf784cf43",
        allowPartialFill: false,
        disableEstimate: true
      },
      headers: {
        'Authorization': `Bearer ${ONEINCH_API_KEY}`
      },
      method: 'GET'
    };

    const response = await axios(config);
    
    // Check for expected fields
    if (response.data) {
      console.log(`🔑 Response keys: ${Object.keys(response.data).join(', ')}`);
      
      // Check for dstAmount (renamed from toAmount in new API version)
      if (response.data.dstAmount) {
        console.log(`✅ Found dstAmount in response: ${response.data.dstAmount}`);
        // Map dstAmount to toAmount for compatibility with our code
        response.data.toAmount = response.data.dstAmount;
      }
      
      // Try to get source token info
      if (response.data.srcToken) {
        console.log(`ℹ️ Source token: ${response.data.srcToken.symbol || 'Unknown'}`);
      }
      
      // Try to get destination token info
      if (response.data.dstToken) {
        console.log(`ℹ️ Destination token: ${response.data.dstToken.symbol || 'Unknown'}`);
        // Map dstToken to toToken for compatibility
        response.data.toToken = response.data.dstToken;
      }
    }
    
    console.log(`✅ Received 1inch swap quote`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error getting 1inch swap quote: ${error.message}`);
    if (error.response) {
      console.error(`❌ Response status: ${error.response.status}`);
      console.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    return null;
  }
}

/**
 * Check if current gas price is below maximum allowed
 * @param {Provider} provider - Ethereum provider
 * @returns {Promise<{isAcceptable: boolean, currentGwei: string, gasPrice: BigNumber}>} Gas price check result
 */
async function checkGasPrice(provider) {
  try {
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
    const isAcceptable = parseFloat(gasPriceGwei) <= MAX_GAS_PRICE_GWEI;
    
    console.log(`⛽ Current gas price: ${gasPriceGwei} gwei (Max: ${MAX_GAS_PRICE_GWEI} gwei)`);
    
    if (!isAcceptable) {
      console.log(`⚠️ Gas price too high! Current: ${gasPriceGwei} gwei, Maximum: ${MAX_GAS_PRICE_GWEI} gwei`);
    }
    
    return {
      isAcceptable,
      currentGwei: gasPriceGwei,
      gasPrice
    };
  } catch (error) {
    console.error(`❌ Error checking gas price: ${error.message}`);
    return {
      isAcceptable: false,
      currentGwei: "unknown",
      gasPrice: ethers.BigNumber.from(0)
    };
  }
}

/**
 * Execute a swap via 1inch
 * @param {Wallet} wallet - Connected wallet
 * @param {Object} quoteData - Quote data from 1inch
 * @param {BigNumber} [gasLimit] - Optional gas limit to use for the transaction
 * @returns {Promise<Object>} Transaction receipt and result
 */
async function executeSwap(wallet, quoteData, gasLimit) {
  try {
    console.log(`💱 Executing 1inch swap...`);
    
    // Check gas price before proceeding
    const { isAcceptable, currentGwei, gasPrice } = await checkGasPrice(wallet.provider);
    if (!isAcceptable) {
      console.log(`🛑 Swap cancelled due to high gas price (${currentGwei} gwei)`);
      return { success: false, error: "high_gas_price" };
    }
    
    // Handle different response structures - ensure we have required fields
    if (!quoteData.tx) {
      console.error(`⚠️ Missing tx field in 1inch response: ${JSON.stringify(Object.keys(quoteData))}`);
      throw new Error('Invalid 1inch response: Missing tx field');
    }
    
    // Extract and validate required fields
    const txTo = quoteData.tx.to;
    const txData = quoteData.tx.data;
    const txValue = quoteData.tx.value ? ethers.BigNumber.from(quoteData.tx.value) : ethers.BigNumber.from(0);
    
    if (!txTo || !txData) {
      throw new Error('Invalid 1inch response: Missing required tx fields');
    }
    
    // Prepare transaction parameters
    const txParams = {
      to: txTo,
      data: txData,
      value: txValue,
      gasPrice: currentGwei * 1e9 // Set the checked gas price
    };
    
    // Use provided gasLimit if available, otherwise estimate
    if (gasLimit) {
      txParams.gasLimit = gasLimit;
    } else {
      // Estimate gas and add 20% buffer
      const gasEstimate = await wallet.estimateGas({
        to: txTo,
        data: txData,
        value: txValue
      });
      txParams.gasLimit = gasEstimate.mul(120).div(100); // Add 20% buffer
    }
    
    // Send the transaction
    const tx = await wallet.sendTransaction(txParams);
    
    console.log(`📝 Swap transaction submitted: ${tx.hash}`);
    
    // Wait for transaction confirmation
    console.log(`⏳ Waiting for swap transaction confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ Swap transaction confirmed in block ${receipt.blockNumber}`);
    
    // Create a standardized response with fallbacks
    let toAmount, toToken;
    
    // Get expected output amount - use dstAmount if toAmount not available
    if (quoteData.toAmount) {
      toAmount = ethers.BigNumber.from(quoteData.toAmount);
    } else if (quoteData.dstAmount) {
      toAmount = ethers.BigNumber.from(quoteData.dstAmount);
    } else if (quoteData.amount) {
      toAmount = ethers.BigNumber.from(quoteData.amount);
    } else {
      // If no amount info available, use a placeholder
      console.warn(`⚠️ No amount information found in 1inch response`);
      toAmount = ethers.BigNumber.from(0);
    }
    
    // Create standardized token information - check for dstToken if toToken not available
    const dstToken = quoteData.dstToken || {};
    const toTokenObj = quoteData.toToken || {};
    
    toToken = {
      address: toTokenObj.address || dstToken.address || quoteData.toTokenAddress || quoteData.dst || "0x0000000000000000000000000000000000000000",
      symbol: toTokenObj.symbol || dstToken.symbol || "Unknown",
      decimals: toTokenObj.decimals || dstToken.decimals || 18
    };
    
    return {
      success: true,
      receipt,
      toAmount,
      toToken
    };
  } catch (error) {
    console.error(`❌ Error executing 1inch swap: ${error.message}`);
    return { success: false };
  }
}

// Main function
async function main() {
  try {
    console.log('🚀 Starting Relay Bridge Bot');
    
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
      
      try {
        // Execute bridge cycle
        await executeBridgeCycle(wallet, config);
      } catch (error) {
        console.error(`❌ Error executing bridge cycle: ${error.message}`);
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

// Find best token to bridge with new strategy
function findBestTokenToBridge(balances) {
  try {
    console.log(`🧮 Analyzing which token to bridge...`);
    
    // First check for WETH balance on any chain
    let sourceWETH = findTokenBalanceOnChains(balances, "WETH");
    if (sourceWETH) {
      console.log(`💹 Found WETH on ${sourceWETH.chainName} with balance ${sourceWETH.formatted}`);
      console.log(`🔄 Will swap WETH to USDC then bridge`);
      return {
        ...sourceWETH,
        targetSymbol: TARGET_TOKENS.WETH // Target is USDC
      };
    }
    
    // Then check for USDC balance on any chain
    let sourceUSDC = findTokenBalanceOnChains(balances, "USDC");
    if (sourceUSDC) {
      console.log(`💹 Found USDC on ${sourceUSDC.chainName} with balance ${sourceUSDC.formatted}`);
      console.log(`🔄 Will swap USDC to WETH then bridge`);
      return {
        ...sourceUSDC,
        targetSymbol: TARGET_TOKENS.USDC // Target is WETH
      };
    }
    
    throw new Error('No available token balance found on any chain');
  } catch (error) {
    console.error(`❌ Error finding best token to bridge: ${error.message}`);
    throw error;
  }
}

// Helper function to find token balance on any chain
function findTokenBalanceOnChains(balances, symbol) {
  let bestBalance = null;
  let bestChainId = null;
  let bestFormatted = null;
  let bestDecimals = null;
  let bestTokenAddress = null;
  
  for (const [chainId, chainData] of Object.entries(balances)) {
    if (chainData[symbol] && chainData[symbol].balance && !chainData[symbol].error) {
      const balance = ethers.BigNumber.from(chainData[symbol].balance);
      
      // Check if balance is above minimum required
      const minAmount = MIN_BRIDGE_AMOUNTS[symbol] || MIN_BRIDGE_AMOUNTS.DEFAULT;
      if (balance.lt(minAmount)) {
        console.log(`⚠️ ${chainData.chainName} ${symbol} balance (${chainData[symbol].formatted}) is below minimum required (${ethers.utils.formatUnits(minAmount, chainData[symbol].decimals)})`);
        continue;
      }
      
      // If we don't have a balance yet, or this one is higher
      if (!bestBalance || balance.gt(bestBalance)) {
        bestBalance = balance;
        bestChainId = Number(chainId);
        bestFormatted = chainData[symbol].formatted;
        bestDecimals = chainData[symbol].decimals;
        bestTokenAddress = chainData[symbol].address;
      }
    }
  }
  
  if (bestBalance) {
    const chainName = Object.entries(bridgeService.chainIds).find(([name, id]) => id === bestChainId)[0];
    return {
      symbol,
      sourceChainId: bestChainId,
      chainName,
      tokenAddress: bestTokenAddress,
      balance: bestBalance,
      formatted: bestFormatted,
      decimals: bestDecimals
    };
  }
  
  return null;
}

// Execute a single bridge cycle
async function executeBridgeCycle(wallet, config) {
  console.log('🔄 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Starting bridge cycle with wallet ${wallet.address}`);
  
  try {
    // Step 1: Check token balances across all chains
    console.log(`👛 Step 1: Checking token balances across all chains...`);
    const balances = await bridgeService.checkTokenBalancesAcrossChains(wallet.address);
    
    // Step 2: Find best token to bridge with our strategy
    console.log(`💰 Step 2: Finding best token to bridge...`);
    const bestToken = findBestTokenToBridge(balances);
    if (!bestToken) {
      console.log(`⚠️ No suitable token found with balance above minimum required`);
      console.log(`⏭️ Skipping bridge cycle due to insufficient amounts`);
      return;
    }
    
    console.log(`💎 Best token found: ${bestToken.symbol} on ${bestToken.chainName}`);
    
    // Check token balances for logging
    const tokenBalance = balances[bestToken.sourceChainId][bestToken.symbol];
    console.log(`💵 Available balance: ${tokenBalance.formatted} ${bestToken.symbol}`);
    
    // Step 3: Calculate bridge amount (100% of balance)
    const totalAmount = bestToken.balance;
    console.log(`💸 Will use ${ethers.utils.formatUnits(totalAmount, bestToken.decimals)} ${bestToken.symbol} (100% of balance)`);
    
    // Step 4: Check if approval is needed for token
    if (bestToken.symbol !== 'ETH') {  // ETH doesn't need approval
      console.log(`🔑 Step 4: Setting up for operations on ${bestToken.chainName}...`);
      
      // Ensure we have the right provider for this chain
      const chainProvider = new ethers.providers.JsonRpcProvider(bridgeService.rpcUrls[bestToken.sourceChainId]);
      const connectedWallet = wallet.connect(chainProvider);
      
      // Check gas price before proceeding
      const { isAcceptable } = await checkGasPrice(chainProvider);
      if (!isAcceptable) {
        console.log(`🛑 Bridge cycle cancelled due to high gas price`);
        return;
      }
      
      // Check ETH balance for gas
      const ethBalance = await connectedWallet.getBalance();
      console.log(`⛽ ETH balance for gas: ${ethers.utils.formatEther(ethBalance)} ETH`);
      
      // Check if we have enough ETH for gas
      const minGasETH = ethers.utils.parseEther("0.0005"); // 0.0005 ETH minimum for gas
      if (ethBalance.lt(minGasETH)) {
        console.log(`⚠️ Insufficient ETH for gas. Need at least 0.0005 ETH, have ${ethers.utils.formatEther(ethBalance)} ETH`);
        
        // Try to bridge ETH for gas from Base chain
        console.log(`🔄 Attempting to bridge ETH for gas from Base chain...`);
        const bridgeSuccess = await bridgeETHForGas(wallet, bestToken.sourceChainId);
        
        if (bridgeSuccess) {
          console.log(`✅ ETH bridge for gas initiated. Checking updated ETH balance...`);
          
          // Check ETH balance again after bridging
          const updatedEthBalance = await connectedWallet.getBalance();
          console.log(`⛽ Updated ETH balance: ${ethers.utils.formatEther(updatedEthBalance)} ETH`);
          
          if (updatedEthBalance.gt(minGasETH)) {
            console.log(`✅ New ETH balance is sufficient for gas. Continuing with operations...`);
            // Continue with operations - ETH balance is now sufficient
          } else {
            console.log(`⚠️ ETH balance is still insufficient. Please try again later when bridge completes.`);
            console.log(`⏭️ Skipping bridge cycle due to insufficient ETH for gas`);
            return;
          }
        } else {
          console.log(`⚠️ Failed to bridge ETH for gas. Please add more ETH to your wallet on ${bestToken.chainName}.`);
          console.log(`⏭️ Skipping bridge cycle due to insufficient ETH for gas`);
          return;
        }
      }
      
      // Step 5: Get swap target token address on the source chain
      const swapTargetSymbol = TARGET_TOKENS[bestToken.symbol];
      const swapTargetAddress = bridgeService.tokenAddresses[bestToken.sourceChainId][swapTargetSymbol];
      
      console.log(`💱 Step 5: Will swap ${bestToken.symbol} to ${swapTargetSymbol} on chain ${bestToken.sourceChainId}`);
      
      // Step 6: Get 1inch swap quote
      console.log(`📊 Step 6: Getting 1inch swap quote...`);
      const swapQuote = await getQuote(
        connectedWallet.address,
        connectedWallet.address,
        bestToken.tokenAddress,
        swapTargetAddress,
        totalAmount,
        bestToken.sourceChainId
      );
      
      if (!swapQuote) {
        throw new Error('Failed to get 1inch swap quote');
      }
      
      // Check for valid response structure
      console.log(`📋 Swap quote response structure: ${JSON.stringify(Object.keys(swapQuote))}`);
      
      // Check for required transaction fields
      if (!swapQuote.tx) {
        console.error(`⚠️ Missing tx field in swap quote response`);
        throw new Error('Invalid swap quote response: Missing tx field');
      }
      
      // Check for destination amount (either toAmount or dstAmount)
      if (!swapQuote.toAmount && !swapQuote.dstAmount) {
        console.error(`⚠️ Missing destination amount in swap quote response`);
        // Add compatibility layer - try to find any amount field
        if (swapQuote.amount) {
          console.log(`ℹ️ Using 'amount' field as destination amount`);
          swapQuote.toAmount = swapQuote.amount;
        } else {
          throw new Error('Invalid swap quote response: Missing destination amount');
        }
      }
      
      // Set target token information (with fallbacks)
      let toTokenDecimals = 18; // Default to 18 decimals
      let toTokenSymbol = swapTargetSymbol; // Use target symbol as fallback
      let toTokenAddress = swapTargetAddress; // Use target address as fallback
      
      // Check for destination token information (using either toToken or dstToken)
      const tokenInfo = swapQuote.toToken || swapQuote.dstToken || {};
      
      if (tokenInfo) {
        if (tokenInfo.decimals !== undefined) {
          toTokenDecimals = tokenInfo.decimals;
        }
        if (tokenInfo.symbol) {
          toTokenSymbol = tokenInfo.symbol;
        }
        if (tokenInfo.address) {
          toTokenAddress = tokenInfo.address;
        }
      } else {
        console.log(`⚠️ No token information found in 1inch response, using fallbacks`);
      }
      
      // Calculate expected output with safe decimals
      const outputAmount = swapQuote.toAmount || swapQuote.dstAmount || swapQuote.amount;
      const expectedOutput = ethers.utils.formatUnits(
        outputAmount,
        toTokenDecimals
      );
      
      console.log(`📈 Expected swap output: ${expectedOutput} ${toTokenSymbol}`);
      
      // Step 7: Approve 1inch router to spend tokens
      console.log(`🔐 Step 7: Approving 1inch router...`);
      
      if (!swapQuote.tx || !swapQuote.tx.to) {
        throw new Error('Failed to get 1inch router address');
      }

      // Get gas price before approval
      const { isAcceptable: isGasPriceAcceptable } = await checkGasPrice(chainProvider);
      if (!isGasPriceAcceptable) {
        console.log(`🛑 Token approval cancelled due to high gas price`);
        return;
      }

      const approvalSuccess = await approveToken(
        connectedWallet,
        bestToken.tokenAddress,
        swapQuote.tx.to // This is the router address, not the token address
      );

      if (!approvalSuccess) {
        throw new Error(`Failed to approve ${bestToken.symbol} for 1inch router`);
      }
      
      // Step 8: Execute swap
      console.log(`💱 Step 8: Executing swap via 1inch...`);
      
      try {
        // Try to estimate gas before executing swap to catch insufficient funds early
        const gasEstimate = await connectedWallet.estimateGas({
          to: swapQuote.tx.to,
          data: swapQuote.tx.data,
          value: swapQuote.tx.value ? ethers.BigNumber.from(swapQuote.tx.value) : ethers.BigNumber.from(0)
        });
        
        console.log(`⛽ Estimated gas: ${gasEstimate.toString()} units`);
        
        // Check if we have enough ETH for gas + buffer
        const gasPrice = await chainProvider.getGasPrice();
        const gasCost = gasEstimate.mul(gasPrice);
        const totalCost = gasCost.add(swapQuote.tx.value ? ethers.BigNumber.from(swapQuote.tx.value) : ethers.BigNumber.from(0));
        
        console.log(`💰 Estimated transaction cost: ${ethers.utils.formatEther(totalCost)} ETH`);
        
        if (ethBalance.lt(totalCost)) {
          console.log(`⚠️ Insufficient ETH for transaction. Need ${ethers.utils.formatEther(totalCost)} ETH, have ${ethers.utils.formatEther(ethBalance)} ETH`);
          throw new Error('Insufficient ETH for transaction');
        }
        
        // Add 20% buffer to gas estimate
        const gasLimit = gasEstimate.mul(120).div(100);
        console.log(`⛽ Using gas limit with 20% buffer: ${gasLimit.toString()} units`);
        
        const swapResult = await executeSwap(connectedWallet, swapQuote, gasLimit);
        
        if (!swapResult.success) {
          throw new Error('1inch swap failed');
        }
        
        console.log(`✅ Swap completed. Ready to bridge ${swapResult.toToken.symbol}`);
        
        // Step 9: Find destination chain
        console.log(`🌉 Step 9: Finding destination chain...`);
        const destinationChainId = bridgeService.findDestinationChain(bestToken.sourceChainId);
        
        // Get proper token address from swap result
        const sourceTokenAddress = swapResult.toToken.address;
        // Check if token address is valid
        if (sourceTokenAddress === "0x0000000000000000000000000000000000000000") {
          console.error(`⚠️ Invalid token address from swap result: ${sourceTokenAddress}`);
          // Try to get the correct token address for the target symbol on this chain
          const correctTokenAddress = bridgeService.tokenAddresses[bestToken.sourceChainId][swapTargetSymbol];
          console.log(`ℹ️ Using fallback token address for ${swapTargetSymbol}: ${correctTokenAddress}`);
          swapResult.toToken.address = correctTokenAddress;
          swapResult.toToken.symbol = swapTargetSymbol; // Force correct symbol
        }
        
        // Get destination currency - it should be opposite of what we're bridging
        // If we're bridging WETH, we want USDC on destination, and vice versa
        const destSymbol = TARGET_TOKENS[swapTargetSymbol]; // Get the opposite token
        const destinationCurrency = bridgeService.tokenAddresses[destinationChainId][destSymbol];
        console.log(`ℹ️ Bridging ${swapTargetSymbol} to ${destSymbol} on chain ${destinationChainId}`);
        
        // Step 10: Request bridge quote
        console.log(`📝 Step 10: Requesting bridge quote...`);
        const quoteResponse = await bridgeService.requestBridgeQuote({
          user: wallet.address,
          recipient: wallet.address,
          originChainId: bestToken.sourceChainId,
          destinationChainId,
          tokenAddress: swapResult.toToken.address,
          symbol: swapTargetSymbol, // Token symbol we're bridging
          amount: swapResult.toAmount,
          slippageTolerance: config.SLIPPAGE_TOLERANCE || "0.5",
          targetSymbol: destSymbol, // Target token on destination chain
          destinationCurrency: destinationCurrency // Address of target token on destination chain
        });
        
        // Step 11: Check if approval needed for bridge
        console.log(`🔐 Step 11: Checking approval for bridge...`);
        
        // Get deposit step
        const depositStep = quoteResponse.steps.find(step => step.id === 'deposit');
        if (!depositStep || !depositStep.items || !depositStep.items.length) {
          throw new Error('Invalid quote response: No deposit step found');
        }
        
        // Get relayer address
        const relayerAddress = depositStep.items[0].data.to;
        console.log(`📄 Relayer address: ${relayerAddress}`);
        
        // Approve relayer if needed
        if (swapResult.toToken.address !== '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE') { // Not ETH
          console.log(`🔐 Approving ${swapResult.toToken.symbol} for relayer ${relayerAddress}...`);
          
          // Get gas price before bridge approval
          const { isAcceptable: isGasPriceAcceptableBridge } = await checkGasPrice(chainProvider);
          if (!isGasPriceAcceptableBridge) {
            console.log(`🛑 Bridge approval cancelled due to high gas price`);
            return;
          }
          
          const bridgeApprovalSuccess = await approveToken(
            connectedWallet,
            swapResult.toToken.address,
            relayerAddress
          );
          
          if (!bridgeApprovalSuccess) {
            throw new Error(`Failed to approve ${swapResult.toToken.symbol} for relayer`);
          }
        }
        
        // Step 12: Execute bridge transaction
        console.log(`🏦 Step 12: Executing bridge transaction...`);

        // Check gas price before executing bridge transaction
        const { isAcceptable: isGasPriceAcceptableBridgeExecution } = await checkGasPrice(chainProvider);
        if (!isGasPriceAcceptableBridgeExecution) {
          console.log(`🛑 Bridge execution cancelled due to high gas price`);
          return;
        }

        const bridgeResult = await bridgeService.executeBridgeTransaction(connectedWallet, quoteResponse, { gasPrice: gasPrice });
        
        // Step 13: Check bridge status
        console.log(`🔍 Step 13: Checking initial bridge status...`);
        const initialStatus = await bridgeService.checkBridgeStatus(bridgeResult.requestId);
        
        console.log(`📊 Initial status: ${initialStatus.status}`);
        console.log(`🔄 Bridge request ID: ${bridgeResult.requestId}`);
        console.log(`🔗 Transaction hash: ${bridgeResult.tx.hash}`);
        
        // Log estimated arrival time
        if (quoteResponse.details && quoteResponse.details.timeEstimate) {
          const estimatedMinutes = Math.ceil(quoteResponse.details.timeEstimate / 60);
          console.log(`⏱️ Estimated arrival time: ~${estimatedMinutes} minutes`);
        }
        
        // Don't mark as completed if still pending
        if (initialStatus.status === 'pending' || initialStatus.status === 'created') {
          console.log(`⏳ Bridge transaction initiated but still pending. Will check status again later.`);
        } else if (initialStatus.status === 'completed') {
          console.log(`✅ Bridge transaction completed successfully!`);
        } else {
          console.log(`ℹ️ Bridge transaction status: ${initialStatus.status}`);
        }
      } catch (error) {
        if (error.message.includes('insufficient funds')) {
          console.log(`⚠️ Insufficient ETH for transaction: ${error.message}`);
          console.log(`⏭️ Skipping bridge cycle due to insufficient ETH for gas`);
          return;
        } else {
          throw error;
        }
      }
    } else {
      console.log(`⚠️ ETH bridging not implemented in this version`);
    }
  } catch (error) {
    console.error(`❌ Error in bridge cycle: ${error.message}`);
    throw error;
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Bridge ETH for gas from Base chain to target chain
 * @param {Wallet} wallet - Wallet to use for bridging
 * @param {number} targetChainId - Target chain ID to bridge to
 * @returns {Promise<boolean>} True if bridging was successful
 */
async function bridgeETHForGas(wallet, targetChainId) {
  try {
    console.log(`🔄 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⛽ Attempting to bridge ETH for gas from Base to chain ${targetChainId}...`);
    
    // Connect to Base chain
    const baseProvider = new ethers.providers.JsonRpcProvider(bridgeService.rpcUrls[CHAIN_IDS.BASE]);
    const baseWallet = wallet.connect(baseProvider);
    
    // Check gas price before proceeding
    const { isAcceptable, currentGwei } = await checkGasPrice(baseProvider);
    if (!isAcceptable) {
      console.log(`🛑 Gas bridging cancelled due to high gas price (${currentGwei} gwei)`);
      return false;
    }
    
    // Check ETH balance on Base
    const baseETHBalance = await baseWallet.getBalance();
    console.log(`💰 ETH balance on Base: ${ethers.utils.formatEther(baseETHBalance)} ETH`);
    
    // Minimum required: gas bridge amount + gas to execute the bridge
    const minRequired = GAS_BRIDGE_AMOUNT.add(ethers.utils.parseEther("0.0005"));
    
    if (baseETHBalance.lt(minRequired)) {
      console.log(`⚠️ Insufficient ETH on Base chain. Need at least ${ethers.utils.formatEther(minRequired)} ETH, have ${ethers.utils.formatEther(baseETHBalance)} ETH`);
      console.log(`❌ Cannot bridge ETH for gas - primary source chain is low on ETH`);
      return false;
    }
    
    // Get destination chain name
    const targetChainName = Object.entries(bridgeService.chainIds).find(([name, id]) => id === targetChainId)[0];
    console.log(`🌉 Will bridge ${ethers.utils.formatEther(GAS_BRIDGE_AMOUNT)} ETH from Base to ${targetChainName}`);
    
    // First wrap ETH to WETH
    console.log(`💱 Wrapping ETH to WETH before bridging...`);
    
    // Get WETH contract address on Base
    const baseWETHAddress = bridgeService.tokenAddresses[CHAIN_IDS.BASE]["WETH"];
    console.log(`📝 Base WETH address: ${baseWETHAddress}`);
    
    // Native ETH address for destination (this is the special case for gas)
    const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
    console.log(`📝 Target chain native ETH address: ${NATIVE_ETH_ADDRESS}`);
    
    // WETH ABI for wrap function
    const wethAbi = [
      "function deposit() external payable",
      "function balanceOf(address) external view returns (uint256)"
    ];
    
    // Create WETH contract instance
    const wethContract = new ethers.Contract(baseWETHAddress, wethAbi, baseWallet);
    
    // Wrap ETH to WETH
    console.log(`🔄 Wrapping ${ethers.utils.formatEther(GAS_BRIDGE_AMOUNT)} ETH to WETH...`);

    // Check gas price again before wrapping ETH to WETH
    const { isAcceptable: isGasPriceAcceptableWrap, gasPrice: wrapGasPrice } = await checkGasPrice(baseProvider);
    if (!isGasPriceAcceptableWrap) {
      console.log(`🛑 ETH wrapping cancelled due to high gas price`);
      return false;
    }

    const wrapTx = await wethContract.deposit({
      value: GAS_BRIDGE_AMOUNT,
      gasLimit: 100000,
      gasPrice: wrapGasPrice
    });
    
    console.log(`📝 Wrap transaction submitted: ${wrapTx.hash}`);
    await wrapTx.wait();
    console.log(`✅ ETH wrapped to WETH successfully`);
    
    // Check WETH balance
    const wethBalance = await wethContract.balanceOf(wallet.address);
    console.log(`💰 WETH balance on Base: ${ethers.utils.formatEther(wethBalance)} WETH`);
    
    // Request bridge quote for WETH to native ETH
    console.log(`📝 Requesting WETH->ETH bridge quote...`);
    
    const quoteResponse = await bridgeService.requestBridgeQuote({
      user: wallet.address,
      recipient: wallet.address,
      originChainId: CHAIN_IDS.BASE,
      destinationChainId: targetChainId,
      tokenAddress: baseWETHAddress,
      symbol: "WETH",
      amount: GAS_BRIDGE_AMOUNT,
      slippageTolerance: "0.5",
      destinationCurrency: NATIVE_ETH_ADDRESS // Native ETH on destination chain
    });
    
    // Execute bridge transaction
    console.log(`🏦 Executing WETH->ETH bridge transaction...`);

    // Check gas price again before executing bridge transaction
    const { isAcceptable: isGasPriceAcceptableBridge, gasPrice: bridgeGasPrice } = await checkGasPrice(baseProvider);
    if (!isGasPriceAcceptableBridge) {
      console.log(`🛑 ETH bridge execution cancelled due to high gas price`);
      return false;
    }

    // Modify executeBridgeTransaction to include gasPrice
    const bridgeResult = await bridgeService.executeBridgeTransaction(baseWallet, quoteResponse, { gasPrice: bridgeGasPrice });
    
    // Check initial status
    console.log(`🔍 Checking initial bridge status...`);
    const initialStatus = await bridgeService.checkBridgeStatus(bridgeResult.requestId);
    
    console.log(`📊 Initial status: ${initialStatus.status}`);
    console.log(`🔄 Gas bridge request ID: ${bridgeResult.requestId}`);
    console.log(`🔗 Gas bridge transaction hash: ${bridgeResult.tx.hash}`);
    
    // Log estimated arrival time
    if (quoteResponse.details && quoteResponse.details.timeEstimate) {
      const estimatedMinutes = Math.ceil(quoteResponse.details.timeEstimate / 60);
      console.log(`⏱️ Estimated arrival time: ~${estimatedMinutes} minutes`);
    }
    
    console.log(`⏳ Waiting 1 minute to check if gas ETH has arrived...`);
    
    // Wait for 1 minute (60 seconds)
    await new Promise(resolve => setTimeout(resolve, 60 * 1000));
    
    // Check bridge status again after waiting
    console.log(`🔍 Checking bridge status after waiting...`);
    const updatedStatus = await bridgeService.checkBridgeStatus(bridgeResult.requestId);
    
    console.log(`📊 Updated status: ${updatedStatus.status}`);
    
    // Check if bridge is completed
    if (updatedStatus.status === 'completed') {
      console.log(`✅ Gas bridge completed successfully! ETH should now be available on ${targetChainName}`);
      return true;
    } else {
      console.log(`⏳ Gas bridge is still in progress (status: ${updatedStatus.status}). It may take a few more minutes to complete.`);
      console.log(`✅ Bridge process has been initiated successfully, but please wait a bit longer before proceeding.`);
      return true; // Return true anyway since we've initiated the bridge
    }
  } catch (error) {
    console.error(`❌ Error bridging ETH for gas: ${error.message}`);
    if (error.response) {
      console.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    return false;
  }
}

// Start the bot
if (require.main === module) {
  main().catch(error => {
    console.error(`❌ Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, executeBridgeCycle, bridgeETHForGas };