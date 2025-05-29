const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
require('dotenv').config();

// Import utilities
const { approveToken } = require('../src/utils/ethereum');
const bridgeService = require('../src/services/bridgeService');

// Chain IDs
const CHAIN_IDS = {
  BASE: 8453,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  LINEA: 59144
};

// 1inch API Key
const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY || "8BaadOaqTnEslDlP7if4OZu7ilHZST9G";

// Amounts for top up
const ETH_PER_WALLET = ethers.utils.parseEther("0.001"); // 0.001 ETH per wallet for gas
const WETH_PER_WALLET = ethers.utils.parseEther("0.001"); // 0.001 WETH per wallet for bridges
const USDC_PER_WALLET = ethers.utils.parseUnits("2", 6); // 2 USDC per wallet

// RPC URL for Base chain
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://base.llamarpc.com";

// Maximum gas price in gwei
const MAX_GAS_PRICE_GWEI = 0.1;

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to ask a question and get input
function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Load wallets from JSON file
function loadWallets() {
  const filePath = path.join(__dirname, '../wallets.json');
  
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️ wallets.json not found. No wallets to top up.`);
    return [];
  }
  
  const walletsData = fs.readFileSync(filePath, 'utf8');
  const wallets = JSON.parse(walletsData);
  
  console.log(`📂 Loaded ${wallets.length} wallets from wallets.json`);
  
  return wallets;
}

// Check if USDC balance is sufficient on Base
async function checkUSDCBalance(wallet, requiredAmount) {
  const provider = new ethers.providers.JsonRpcProvider(BASE_RPC_URL);
  
  // Get USDC token contract
  const usdcAddress = bridgeService.tokenAddresses[CHAIN_IDS.BASE].USDC;
  const usdcContract = new ethers.Contract(
    usdcAddress,
    ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
    provider
  );
  
  // Get USDC balance and decimals
  const decimals = await usdcContract.decimals();
  const balance = await usdcContract.balanceOf(wallet.address);
  const formattedBalance = ethers.utils.formatUnits(balance, decimals);
  
  console.log(`💰 USDC balance on Base: ${formattedBalance} USDC`);
  
  // Check if balance is sufficient
  const isEnough = balance.gte(requiredAmount);
  
  if (!isEnough) {
    const formatted = ethers.utils.formatUnits(requiredAmount, decimals);
    console.log(`⚠️ Insufficient USDC. You need at least ${formatted} USDC, but have ${formattedBalance} USDC`);
  }
  
  return { isEnough, balance, decimals, formattedBalance };
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

// Get quote from 1inch API
async function getSwapQuote(account, from, to, amount, chainId, receiver = null) {
  try {
    console.log(`🔄 Getting 1inch swap quote for ${ethers.utils.formatUnits(amount, from === bridgeService.tokenAddresses[CHAIN_IDS.BASE].USDC ? 6 : 18)} ${from === bridgeService.tokenAddresses[CHAIN_IDS.BASE].USDC ? 'USDC' : 'ETH'} to ${to === bridgeService.tokenAddresses[CHAIN_IDS.BASE].WETH ? 'WETH' : 'ETH'}...`);
    
    // Use provided receiver or fallback to account
    const actualReceiver = receiver || account;
    
    const config = {
      url: `https://api.1inch.dev/swap/v6.0/${chainId}/swap`,
      params: {
        src: from,
        dst: to,
        amount: amount.toString(),
        from: account,
        receiver: actualReceiver, // Set receiver to destination address
        slippage: 1,
        fee: 1,
        referrer: "0x00000015c1106ffdfc6e0b6edb54176bf784cf43",
        disableEstimate: true
      },
      headers: {
        'Authorization': `Bearer ${ONEINCH_API_KEY}`
      },
      method: 'GET'
    };
    
    const response = await axios(config);
    console.log(`✅ Received 1inch swap quote (receiver: ${actualReceiver})`);
    
    // Ensure dstAmount is mapped to toAmount for compatibility
    if (response.data.dstAmount && !response.data.toAmount) {
      response.data.toAmount = response.data.dstAmount;
    }
    
    return response.data;
  } catch (error) {
    console.error(`❌ Error getting 1inch swap quote: ${error.message}`);
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
      console.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    return null;
  }
}

// Swap USDC to ETH/WETH
async function swapUSDCToToken(mainWallet, destinationAddress, amount, targetToken) {
  try {
    const isWETH = targetToken === 'WETH';
    console.log(`💱 Swapping USDC to ${isWETH ? 'WETH' : 'ETH'} for ${destinationAddress}...`);
    
    // Connect provider
    const provider = new ethers.providers.JsonRpcProvider(BASE_RPC_URL);
    const wallet = new ethers.Wallet(mainWallet.privateKey, provider);
    
    // Check gas price before proceeding
    const { isAcceptable, gasPrice } = await checkGasPrice(provider);
    if (!isAcceptable) {
      console.log(`🛑 Swap cancelled due to high gas price`);
      return false;
    }
    
    // Get token addresses
    const usdcAddress = bridgeService.tokenAddresses[CHAIN_IDS.BASE].USDC;
    const wethAddress = bridgeService.tokenAddresses[CHAIN_IDS.BASE].WETH;
    
    // Destination token is either WETH or ETH (0xEeee...)
    const destinationToken = isWETH ? wethAddress : "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    
    // Get swap quote with destinationAddress as receiver
    const swapQuote = await getSwapQuote(
      wallet.address,
      usdcAddress,
      destinationToken,
      amount,
      CHAIN_IDS.BASE,
      destinationAddress // Set destination address as receiver
    );
    
    if (!swapQuote || !swapQuote.tx) {
      throw new Error('Failed to get valid swap quote');
    }
    
    // Approve 1inch router to spend USDC
    const routerAddress = swapQuote.tx.to;
    console.log(`🔐 Approving 1inch router (${routerAddress}) to spend USDC...`);
    
    // Check gas price again before approval
    const { isAcceptable: isApprovalGasPriceAcceptable, gasPrice: approvalGasPrice } = await checkGasPrice(provider);
    if (!isApprovalGasPriceAcceptable) {
      console.log(`🛑 Token approval cancelled due to high gas price`);
      return false;
    }
    
    // Modify approveToken call to use the checked gas price
    const approvalSuccess = await approveToken(wallet, usdcAddress, routerAddress, { gasPrice: approvalGasPrice });
    if (!approvalSuccess) {
      throw new Error('Failed to approve USDC for swap');
    }
    
    // Execute swap
    console.log(`💱 Executing swap with receiver set to ${destinationAddress}...`);
    
    // Estimate gas
    const gasEstimate = await wallet.estimateGas({
      to: swapQuote.tx.to,
      data: swapQuote.tx.data,
      value: swapQuote.tx.value ? ethers.BigNumber.from(swapQuote.tx.value) : ethers.BigNumber.from(0)
    });
    
    // Add 20% buffer
    const gasLimit = gasEstimate.mul(120).div(100);
    
    // Send transaction
    const tx = await wallet.sendTransaction({
      to: swapQuote.tx.to,
      data: swapQuote.tx.data,
      value: swapQuote.tx.value ? ethers.BigNumber.from(swapQuote.tx.value) : ethers.BigNumber.from(0),
      gasPrice: gasPrice
    });
    
    console.log(`📝 Swap transaction submitted: ${tx.hash}`);
    
    // Wait for confirmation
    console.log(`⏳ Waiting for transaction confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ Swap confirmed in block ${receipt.blockNumber}`);
    
    // Get amount from swap result for logging
    const resultAmount = swapQuote.toAmount || swapQuote.dstAmount;
    const formattedAmount = ethers.utils.formatUnits(resultAmount, isWETH ? 18 : 18);
    
    console.log(`✅ Successfully sent ${formattedAmount} ${isWETH ? 'WETH' : 'ETH'} to ${destinationAddress}`);
    
    return true;
  } catch (error) {
    console.error(`❌ Error swapping USDC to ${targetToken}: ${error.message}`);
    return false;
  }
}

// Top up a single wallet with ETH and WETH
async function topUpWallet(mainWallet, walletAddress) {
  console.log(`🚀 Topping up wallet: ${walletAddress}`);
  
  // Top up with ETH
  console.log(`💸 Topping up with ETH...`);
  const ethSuccess = await swapUSDCToToken(mainWallet, walletAddress, USDC_PER_WALLET.div(2), 'ETH');
  
  if (!ethSuccess) {
    console.log(`⚠️ Failed to top up wallet with ETH`);
    return false;
  }
  
  // Top up with WETH
  console.log(`💸 Topping up with WETH...`);
  const wethSuccess = await swapUSDCToToken(mainWallet, walletAddress, USDC_PER_WALLET.div(2), 'WETH');
  
  if (!wethSuccess) {
    console.log(`⚠️ Failed to top up wallet with WETH`);
    return false;
  }
  
  console.log(`✅ Successfully topped up wallet ${walletAddress} with ETH and WETH`);
  return true;
}

// Top up all wallets
async function topUpAllWallets(mainWallet) {
  const wallets = loadWallets();
  
  if (wallets.length === 0) {
    console.log(`❌ No wallets found to top up`);
    return;
  }
  
  console.log(`🚀 Topping up ${wallets.length} wallets with ETH and WETH...`);
  
  // Calculate required USDC
  const requiredUSDC = USDC_PER_WALLET.mul(wallets.length);
  const { isEnough } = await checkUSDCBalance(mainWallet, requiredUSDC);
  
  if (!isEnough) {
    const proceed = await askQuestion('Your USDC balance is insufficient. Do you want to continue anyway? (y/n) ');
    
    if (proceed.toLowerCase() !== 'y' && proceed.toLowerCase() !== 'yes') {
      console.log('❌ Aborted. Please add more USDC to your wallet and try again.');
      return;
    }
  }
  
  let successCount = 0;
  
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    console.log(`⏳ Processing wallet ${i+1}/${wallets.length}: ${wallet.address}`);
    
    const success = await topUpWallet(mainWallet, wallet.address);
    
    if (success) {
      successCount++;
    }
  }
  
  console.log(`🎉 Topped up ${successCount}/${wallets.length} wallets successfully`);
}

// Main function
async function main() {
  try {
    console.log('🚀 Starting Wallet Top Up');
    
    // Ask for main wallet private key
    const privateKey = await askQuestion('Enter your main wallet private key (with USDC on Base): ');
    
    if (!privateKey || privateKey.trim() === '') {
      console.error('❌ Invalid private key.');
      return;
    }
    
    try {
      // Create wallet from private key
      const mainWallet = new ethers.Wallet(privateKey.trim());
      console.log(`ℹ️ Using main wallet: ${mainWallet.address}`);
      
      // Ask which wallet to top up
      const topUpChoice = await askQuestion('Do you want to top up all wallets or a specific one? (all/specific): ');
      
      if (topUpChoice.toLowerCase() === 'all') {
        await topUpAllWallets(mainWallet);
      } else if (topUpChoice.toLowerCase() === 'specific') {
        const address = await askQuestion('Enter the wallet address to top up: ');
        
        if (!ethers.utils.isAddress(address)) {
          console.error('❌ Invalid wallet address.');
          return;
        }
        
        await topUpWallet(mainWallet, address);
      } else {
        console.error('❌ Invalid choice. Please enter "all" or "specific".');
        return;
      }
      
      console.log('🎉 Top up process completed!');
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    // Close readline interface
    rl.close();
  }
}

// Start the script
if (require.main === module) {
  main().catch(error => {
    console.error(`❌ Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { topUpWallet, topUpAllWallets }; 