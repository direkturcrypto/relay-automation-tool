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

// Amounts for setup
const ETH_PER_WALLET = ethers.utils.parseEther("0.002"); // 0.002 ETH per wallet for gas
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

// Generate new wallets
async function generateWallets(count) {
  console.log(`🔑 Generating ${count} new wallets...`);
  
  const wallets = [];
  
  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom();
    
    wallets.push({
      privateKey: wallet.privateKey,
      address: wallet.address,
      active: true
    });
    
    console.log(`✅ Generated wallet ${i+1}/${count}: ${wallet.address}`);
  }
  
  return wallets;
}

// Save wallets to JSON file
function saveWallets(wallets) {
  const filePath = path.join(__dirname, '../wallets.json');
  
  fs.writeFileSync(filePath, JSON.stringify(wallets, null, 2));
  
  console.log(`💾 Saved ${wallets.length} wallets to wallets.json`);
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
    console.log(`🔄 Getting 1inch swap quote for ${ethers.utils.formatEther(amount)} ETH to USDC...`);
    
    // Use the provided receiver or fallback to the account
    const actualReceiver = receiver || account;
    
    const config = {
      url: `https://api.1inch.dev/swap/v6.0/${chainId}/swap`,
      params: {
        src: from,
        dst: to,
        amount: amount.toString(),
        from: account,
        receiver: actualReceiver, // Set the receiver to destination address
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
async function swapUSDCToETH(mainWallet, destinationAddress, amount, isWETH = false) {
  try {
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
      gasLimit: gasLimit,
      gasPrice: gasPrice
    });
    
    console.log(`📝 Swap transaction submitted: ${tx.hash}`);
    
    // Wait for confirmation
    console.log(`⏳ Waiting for transaction confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ Swap confirmed in block ${receipt.blockNumber}`);
    
    // Get amount from swap result for logging
    const resultAmount = swapQuote.toAmount || swapQuote.dstAmount;
    const formattedAmount = isWETH 
      ? ethers.utils.formatEther(resultAmount)
      : ethers.utils.formatEther(resultAmount);
      
    console.log(`✅ Successfully sent ${formattedAmount} ${isWETH ? 'WETH' : 'ETH'} to ${destinationAddress}`);
    
    return true;
  } catch (error) {
    console.error(`❌ Error swapping USDC to ${isWETH ? 'WETH' : 'ETH'}: ${error.message}`);
    return false;
  }
}

// Setup wallets with ETH and WETH for gas and bridges
async function setupWallets(mainWallet, newWallets) {
  console.log(`🚀 Setting up ${newWallets.length} wallets with ETH and WETH...`);
  
  // First, fund all wallets with ETH for gas
  for (let i = 0; i < newWallets.length; i++) {
    const wallet = newWallets[i];
    console.log(`💸 Setting up wallet ${i+1}/${newWallets.length}: ${wallet.address}`);
    
    // Swap USDC to ETH and send to wallet
    const ethSuccess = await swapUSDCToETH(mainWallet, wallet.address, USDC_PER_WALLET.div(2), false);
    
    if (!ethSuccess) {
      console.log(`⚠️ Failed to fund wallet ${wallet.address} with ETH`);
      continue;
    }
    
    // Swap USDC to WETH and send to wallet
    const wethSuccess = await swapUSDCToETH(mainWallet, wallet.address, USDC_PER_WALLET.div(2), true);
    
    if (!wethSuccess) {
      console.log(`⚠️ Failed to fund wallet ${wallet.address} with WETH`);
      continue;
    }
    
    console.log(`✅ Successfully funded wallet ${wallet.address} with ETH and WETH`);
  }
  
  console.log(`✅ Completed wallet setup`);
}

// Main function
async function main() {
  try {
    console.log('🚀 Starting Wallet Generator');
    
    // Ask how many wallets to generate
    const countStr = await askQuestion('How many wallets do you want to generate? ');
    const count = parseInt(countStr.trim());
    
    if (isNaN(count) || count <= 0) {
      console.error('❌ Invalid count. Please enter a positive number.');
      return;
    }
    
    // Calculate required USDC
    const requiredUSDC = USDC_PER_WALLET.mul(count);
    const requiredUSDCFormatted = ethers.utils.formatUnits(requiredUSDC, 6);
    
    console.log(`ℹ️ You'll need at least ${requiredUSDCFormatted} USDC to fund ${count} wallets`);
    
    // Ask if user wants to top up gas
    const topUpGas = await askQuestion('Do you want to top up the gas for these wallets? (y/n) ');
    
    if (topUpGas.toLowerCase() === 'y' || topUpGas.toLowerCase() === 'yes') {
      // Ask for main wallet private key
      const privateKey = await askQuestion('Enter your main wallet private key: ');
      
      if (!privateKey || privateKey.trim() === '') {
        console.error('❌ Invalid private key.');
        return;
      }
      
      try {
        // Create wallet from private key
        const mainWallet = new ethers.Wallet(privateKey.trim());
        console.log(`ℹ️ Using main wallet: ${mainWallet.address}`);
        
        // Check USDC balance
        const { isEnough } = await checkUSDCBalance(mainWallet, requiredUSDC);
        
        if (!isEnough) {
          const proceed = await askQuestion('Your USDC balance is insufficient. Do you want to continue anyway? (y/n) ');
          
          if (proceed.toLowerCase() !== 'y' && proceed.toLowerCase() !== 'yes') {
            console.log('❌ Aborted. Please add more USDC to your wallet and try again.');
            return;
          }
        }
        
        // Generate wallets
        const newWallets = await generateWallets(count);
        
        // Save wallets
        saveWallets(newWallets);
        
        // Setup wallets with ETH and WETH
        await setupWallets(mainWallet, newWallets);
        
        console.log('🎉 All done! Your wallets are ready for use.');
      } catch (error) {
        console.error(`❌ Error: ${error.message}`);
      }
    } else {
      // Just generate wallets without top up
      const newWallets = await generateWallets(count);
      
      // Save wallets
      saveWallets(newWallets);
      
      console.log('🎉 Wallets generated! Note: These wallets do not have any funds yet.');
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

module.exports = { generateWallets, setupWallets }; 