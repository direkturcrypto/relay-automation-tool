const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

// Import services
const bridgeService = require('../src/services/bridgeService');

// Chain IDs
const CHAIN_IDS = {
  BASE: 8453,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  LINEA: 59144
};

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
    console.log(`⚠️ wallets.json not found. No wallets to withdraw from.`);
    return [];
  }
  
  const walletsData = fs.readFileSync(filePath, 'utf8');
  const wallets = JSON.parse(walletsData);
  
  console.log(`📂 Loaded ${wallets.length} wallets from wallets.json`);
  
  return wallets;
}

// Check balances for a wallet across all chains and tokens
async function checkAllBalances(walletAddress) {
  console.log(`🔍 Checking balances for ${walletAddress} across all chains and tokens...`);
  
  // Initialize providers for all chains
  const providers = {};
  const balances = {};
  
  for (const [chainName, chainId] of Object.entries(CHAIN_IDS)) {
    const rpcUrl = bridgeService.rpcUrls[chainId];
    providers[chainId] = new ethers.providers.JsonRpcProvider(rpcUrl);
    balances[chainId] = { chainName, nativeToken: { symbol: 'ETH', balance: ethers.BigNumber.from(0) } };
  }
  
  // Check ETH balances on all chains
  for (const [chainId, provider] of Object.entries(providers)) {
    try {
      const ethBalance = await provider.getBalance(walletAddress);
      const formattedBalance = ethers.utils.formatEther(ethBalance);
      
      balances[chainId].nativeToken = {
        symbol: 'ETH',
        balance: ethBalance,
        formatted: formattedBalance
      };
      
      if (ethBalance.gt(0)) {
        console.log(`💰 Found ${formattedBalance} ETH on ${balances[chainId].chainName}`);
      }
    } catch (error) {
      console.error(`❌ Error checking ETH balance on chain ${chainId}: ${error.message}`);
    }
  }
  
  // Check token balances on all chains
  for (const [chainId, provider] of Object.entries(providers)) {
    try {
      const tokens = bridgeService.tokenAddresses[chainId];
      
      for (const [symbol, address] of Object.entries(tokens)) {
        try {
          const tokenContract = new ethers.Contract(
            address,
            ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
            provider
          );
          
          const decimals = await tokenContract.decimals();
          const balance = await tokenContract.balanceOf(walletAddress);
          const formatted = ethers.utils.formatUnits(balance, decimals);
          
          if (balance.gt(0)) {
            console.log(`💰 Found ${formatted} ${symbol} on ${balances[chainId].chainName}`);
            
            if (!balances[chainId].tokens) {
              balances[chainId].tokens = {};
            }
            
            balances[chainId].tokens[symbol] = {
              address,
              balance,
              decimals,
              formatted
            };
          }
        } catch (error) {
          console.error(`❌ Error checking ${symbol} balance on chain ${chainId}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error processing tokens on chain ${chainId}: ${error.message}`);
    }
  }
  
  return balances;
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

// Withdraw all tokens from a wallet to the destination address
async function withdrawFromWallet(wallet, destinationAddress) {
  console.log(`🔄 Processing wallet: ${wallet.address}...`);
  
  // Check all balances
  const balances = await checkAllBalances(wallet.address);
  let successCount = 0;
  let failureCount = 0;
  
  // Connect wallet to each chain and withdraw tokens
  for (const [chainId, chainData] of Object.entries(balances)) {
    // Skip if no balances on this chain
    if (!chainData.nativeToken.balance.gt(0) && (!chainData.tokens || Object.keys(chainData.tokens).length === 0)) {
      continue;
    }
    
    console.log(`⏳ Processing chain: ${chainData.chainName}...`);
    
    const provider = new ethers.providers.JsonRpcProvider(bridgeService.rpcUrls[chainId]);
    const walletWithProvider = new ethers.Wallet(wallet.privateKey, provider);
    
    // First, transfer tokens if any
    if (chainData.tokens && Object.keys(chainData.tokens).length > 0) {
      for (const [symbol, tokenData] of Object.entries(chainData.tokens)) {
        console.log(`💸 Transferring ${tokenData.formatted} ${symbol}...`);
        
        try {
          // Check gas price before token transfer
          const { isAcceptable, gasPrice } = await checkGasPrice(provider);
          if (!isAcceptable) {
            console.log(`🛑 ${symbol} transfer cancelled due to high gas price`);
            failureCount++;
            continue;
          }
          
          // Create token contract instance
          const tokenContract = new ethers.Contract(
            tokenData.address,
            [
              'function transfer(address,uint256) returns (bool)',
              'function approve(address,uint256) returns (bool)',
              'function allowance(address,address) view returns (uint256)'
            ],
            walletWithProvider
          );
          
          // Transfer all tokens
          const tx = await tokenContract.transfer(destinationAddress, tokenData.balance, {
            gasPrice
          });
          console.log(`📝 Transaction submitted: ${tx.hash}`);
          
          // Wait for confirmation
          await tx.wait();
          console.log(`✅ Successfully transferred ${tokenData.formatted} ${symbol} to ${destinationAddress}`);
          successCount++;
        } catch (error) {
          console.error(`❌ Error transferring ${symbol}: ${error.message}`);
          failureCount++;
        }
      }
    }
    
    // Then, transfer ETH if any (keeping some for gas)
    if (chainData.nativeToken.balance.gt(0)) {
      try {
        // Check gas price before ETH transfer
        const { isAcceptable, gasPrice } = await checkGasPrice(provider);
        if (!isAcceptable) {
          console.log(`🛑 ETH transfer cancelled due to high gas price`);
          failureCount++;
          return { successCount, failureCount };
        }
        
        // Estimate gas cost for a basic transaction
        console.log(`💸 Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);
        const gasLimit = 21000; // Standard gas for ETH transfer
        const gasCost = gasPrice.mul(gasLimit);
        
        // Keep enough for gas plus a small buffer
        const buffer = gasCost.mul(2); // 2x buffer
        
        // Amount to transfer (all balance minus buffer for gas)
        let amountToTransfer = chainData.nativeToken.balance.sub(buffer);
        
        // If amount is negative or very small, don't transfer
        if (amountToTransfer.lte(ethers.utils.parseEther("0.00001"))) {
          console.log(`⚠️ ETH balance too low to transfer (need to keep some for gas)`);
          continue;
        }
        
        console.log(`💸 Transferring ${ethers.utils.formatEther(amountToTransfer)} ETH...`);
        
        // Send transaction
        const tx = await walletWithProvider.sendTransaction({
          to: destinationAddress,
          value: amountToTransfer,
          gasPrice,
          gasLimit
        });
        
        console.log(`📝 Transaction submitted: ${tx.hash}`);
        
        // Wait for confirmation
        await tx.wait();
        console.log(`✅ Successfully transferred ETH to ${destinationAddress}`);
        successCount++;
      } catch (error) {
        console.error(`❌ Error transferring ETH: ${error.message}`);
        failureCount++;
      }
    }
  }
  
  return { successCount, failureCount };
}

// Withdraw from all wallets
async function withdrawFromAllWallets(destinationAddress) {
  console.log(`🚀 Starting withdrawal process to ${destinationAddress}`);
  
  // Load wallets
  const wallets = loadWallets();
  
  if (wallets.length === 0) {
    console.log(`❌ No wallets found to withdraw from`);
    return;
  }
  
  let totalSuccessCount = 0;
  let totalFailureCount = 0;
  
  // Process each wallet
  for (let i = 0; i < wallets.length; i++) {
    console.log(`⏳ Processing wallet ${i+1}/${wallets.length}`);
    const wallet = wallets[i];
    
    const { successCount, failureCount } = await withdrawFromWallet(wallet, destinationAddress);
    totalSuccessCount += successCount;
    totalFailureCount += failureCount;
  }
  
  console.log(`🎉 Withdrawal process completed!`);
  console.log(`✅ Successfully executed ${totalSuccessCount} transfer(s)`);
  if (totalFailureCount > 0) {
    console.log(`❌ Failed to execute ${totalFailureCount} transfer(s)`);
  }
}

// Main function
async function main() {
  try {
    console.log('🚀 Starting Wallet Withdrawal Tool');
    
    // Ask for destination address
    const destinationAddress = await askQuestion('Enter the destination address to withdraw all funds to: ');
    
    if (!ethers.utils.isAddress(destinationAddress)) {
      console.error('❌ Invalid Ethereum address');
      return;
    }
    
    // Confirm action
    const confirm = await askQuestion(`⚠️ This will withdraw ALL funds from ALL wallets in wallets.json to ${destinationAddress}. Continue? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      console.log('❌ Operation canceled');
      return;
    }
    
    // Execute withdrawal
    await withdrawFromAllWallets(destinationAddress);
    
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

module.exports = { withdrawFromWallet, withdrawFromAllWallets }; 