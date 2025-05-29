const { ethers } = require('ethers');
const axios = require('axios');
const relayService = require('./relayService');
const ethereumUtils = require('../utils/ethereum');
const constants = require('../config/constants');
require('dotenv').config();

/**
 * Service for handling cross-chain token bridges via Relay
 */
class BridgeService {
  constructor() {
    // Chain IDs for supported networks
    this.chainIds = {
      base: 8453,
      arbitrum: 42161,
      optimism: 10,
      linea: 59144
    };
    
    // Token addresses on different chains (initially just copying from Base)
    this.tokenAddresses = {
      // Base tokens
      8453: {
        USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        WETH: "0x4200000000000000000000000000000000000006"
      },
      // Arbitrum tokens
      42161: {
        USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
      },
      // Optimism tokens
      10: {
        USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        WETH: "0x4200000000000000000000000000000000000006"
      },
      // Linea tokens
      59144: {
        USDC: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
        WETH: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f"
      }
    };
    
    // RPC URLs for each chain
    this.rpcUrls = {
      8453: process.env.BASE_RPC_URL || "https://base.llamarpc.com",
      42161: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      10: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      59144: process.env.LINEA_RPC_URL || "https://rpc.linea.build"
    };
  }

  /**
   * Initialize providers for multiple chains
   * @returns {Object} Object with providers for each chain
   */
  initializeProviders() {
    try {
      console.log(`🌐 Initializing providers for multiple chains...`);
      
      const providers = {};
      for (const [chainName, chainId] of Object.entries(this.chainIds)) {
        const rpcUrl = this.rpcUrls[chainId];
        console.log(`🔌 Setting up provider for ${chainName} (${chainId}) using RPC: ${rpcUrl}`);
        providers[chainId] = new ethers.providers.JsonRpcProvider(rpcUrl);
      }
      
      console.log(`✅ Successfully initialized ${Object.keys(providers).length} providers`);
      return providers;
    } catch (error) {
      console.error(`❌ Error initializing providers: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check token balances across all supported chains
   * @param {string} walletAddress - Address to check balances for
   * @returns {Promise<Object>} Balances by chain and token
   */
  async checkTokenBalancesAcrossChains(walletAddress) {
    try {
      console.log(`💰 Checking token balances for ${walletAddress} across all chains...`);
      
      const providers = this.initializeProviders();
      const balances = {};
      
      for (const [chainName, chainId] of Object.entries(this.chainIds)) {
        console.log(`🔍 Checking balances on ${chainName} (${chainId})...`);
        
        balances[chainId] = { chainName };
        const provider = providers[chainId];
        
        // Check each token balance
        for (const [symbol, address] of Object.entries(this.tokenAddresses[chainId])) {
          try {
            const tokenContract = new ethers.Contract(
              address,
              require('../../abis/erc20.json'),
              provider
            );
            
            const decimals = await tokenContract.decimals();
            const balance = await tokenContract.balanceOf(walletAddress);
            const formatted = ethers.utils.formatUnits(balance, decimals);
            
            balances[chainId][symbol] = {
              address,
              balance,
              formatted,
              decimals
            };
            
            console.log(`💵 ${chainName} ${symbol}: ${formatted}`);
          } catch (err) {
            console.error(`⚠️ Error checking ${symbol} on ${chainName}: ${err.message}`);
            balances[chainId][symbol] = { error: err.message };
          }
        }
      }
      
      return balances;
    } catch (error) {
      console.error(`❌ Error checking balances across chains: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find best token to bridge
   * @param {Object} balances - Token balances across chains
   * @returns {Object} Best token and source chain info
   */
  findBestTokenToBridge(balances) {
    try {
      console.log(`🧮 Analyzing which token to bridge...`);
      
      let bestToken = null;
      let sourceChainId = null;
      let tokenAddress = null;
      let tokenBalance = ethers.BigNumber.from(0);
      
      // First check if we have any USDC balance on any chain
      for (const [chainId, chainData] of Object.entries(balances)) {
        if (chainData.USDC && chainData.USDC.balance && !chainData.USDC.error) {
          const balance = ethers.BigNumber.from(chainData.USDC.balance);
          
          if (balance.gt(tokenBalance)) {
            console.log(`💹 Found USDC on ${chainData.chainName} with balance ${chainData.USDC.formatted}`);
            bestToken = 'USDC';
            sourceChainId = Number(chainId);
            tokenAddress = chainData.USDC.address;
            tokenBalance = balance;
          }
        }
      }
      
      // If no USDC with balance, check WETH
      if (!bestToken) {
        for (const [chainId, chainData] of Object.entries(balances)) {
          if (chainData.WETH && chainData.WETH.balance && !chainData.WETH.error) {
            const balance = ethers.BigNumber.from(chainData.WETH.balance);
            
            if (balance.gt(tokenBalance)) {
              console.log(`💹 Found WETH on ${chainData.chainName} with balance ${chainData.WETH.formatted}`);
              bestToken = 'WETH';
              sourceChainId = Number(chainId);
              tokenAddress = chainData.WETH.address;
              tokenBalance = balance;
            }
          }
        }
      }
      
      if (!bestToken) {
        throw new Error('No available token balance found on any chain');
      }
      
      const chainName = Object.entries(this.chainIds).find(([name, id]) => id === sourceChainId)[0];
      
      console.log(`✅ Best token to bridge: ${bestToken} from ${chainName} (${sourceChainId})`);
      return {
        symbol: bestToken,
        sourceChainId,
        chainName,
        tokenAddress,
        balance: tokenBalance
      };
    } catch (error) {
      console.error(`❌ Error finding best token to bridge: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find destination chain for bridging
   * @param {number} sourceChainId - Source chain ID
   * @returns {number} Destination chain ID
   */
  findDestinationChain(sourceChainId) {
    try {
      console.log(`🌉 Finding destination chain from source chain ${sourceChainId}...`);
      
      // Get all chain IDs except the source
      const availableChainIds = Object.values(this.chainIds).filter(id => id !== sourceChainId);
      
      // Randomly select a destination chain
      const destinationChainId = availableChainIds[Math.floor(Math.random() * availableChainIds.length)];
      
      const sourceName = Object.entries(this.chainIds).find(([name, id]) => id === sourceChainId)[0];
      const destName = Object.entries(this.chainIds).find(([name, id]) => id === destinationChainId)[0];
      
      console.log(`✅ Selected destination chain: ${destName} (${destinationChainId}) from ${sourceName}`);
      return destinationChainId;
    } catch (error) {
      console.error(`❌ Error finding destination chain: ${error.message}`);
      throw error;
    }
  }

  /**
   * Request bridge quote from Relay API
   * @param {Object} params - Bridge parameters
   * @returns {Promise<Object>} Bridge quote response
   */
  async requestBridgeQuote(params) {
    try {
      console.log(`🔍 Requesting bridge quote from Relay API...`);
      
      // Get destination currency based on target symbol if provided
      let destinationCurrency = params.destinationCurrency; // First check if explicitly provided
      
      if (!destinationCurrency && params.targetSymbol) {
        console.log(`🎯 Using target symbol: ${params.targetSymbol}`);
        destinationCurrency = this.tokenAddresses[params.destinationChainId][params.targetSymbol];
        console.log(`💸 Bridging ${params.amount} ${params.symbol} from chain ${params.originChainId} to ${params.destinationChainId} as ${params.targetSymbol}`);
      } else if (!destinationCurrency) {
        // Default behavior: same token on destination chain
        destinationCurrency = this.tokenAddresses[params.destinationChainId][params.symbol];
        console.log(`💸 Bridging ${params.amount} ${params.symbol} from chain ${params.originChainId} to ${params.destinationChainId}`);
      } else {
        console.log(`💸 Bridging ${params.amount} ${params.symbol} from chain ${params.originChainId} to ${params.destinationChainId} using explicit destination currency`);
      }
      
      // Use relayService to get the quote
      const quoteParams = {
        user: params.user,
        recipient: params.recipient || params.user,
        originChainId: params.originChainId.toString(),
        destinationChainId: params.destinationChainId.toString(),
        originCurrency: params.tokenAddress,
        destinationCurrency: destinationCurrency,
        amount: params.amount.toString(),
        slippageTolerance: params.slippageTolerance || "0.5",
        referrer: "relay.link"
      };
      
      console.log(`📤 Requesting quote with params: ${JSON.stringify(quoteParams, null, 2)}`);
      
      const response = await relayService.requestQuote(quoteParams);
      
      console.log(`📥 Received bridge quote response`);
      return response.data;
    } catch (error) {
      console.error(`❌ Error requesting bridge quote: ${error.message}`);
      if (error.response) {
        console.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  /**
   * Execute a bridge transaction
   * @param {Wallet} wallet - Ethers.js wallet
   * @param {Object} quoteResponse - Quote response from Relay API
   * @returns {Promise<Object>} Transaction response
   */
  async executeBridgeTransaction(wallet, quoteResponse) {
    try {
      console.log(`🌉 Executing bridge transaction...`);
      
      if (!quoteResponse.steps || !quoteResponse.steps.length) {
        throw new Error('Invalid quote response: No steps found');
      }
      
      const depositStep = quoteResponse.steps.find(step => step.id === 'deposit');
      if (!depositStep || !depositStep.items || !depositStep.items.length) {
        throw new Error('Invalid quote response: No deposit step found');
      }
      
      const txData = depositStep.items[0].data;
      console.log(`📝 Transaction data: ${JSON.stringify(txData, null, 2)}`);
      
      // Ensure we're using the right provider for the source chain
      const provider = new ethers.providers.JsonRpcProvider(this.rpcUrls[txData.chainId]);
      const connectedWallet = wallet.connect(provider);
      
      console.log(`🔑 Executing transaction from ${wallet.address} on chain ${txData.chainId}...`);
      
      // Send the transaction
      const tx = await connectedWallet.sendTransaction({
        to: txData.to,
        data: txData.data,
        value: txData.value ? ethers.BigNumber.from(txData.value) : 0,
        gasPrice: txData.gasPrice ? ethers.BigNumber.from(txData.gasPrice) : 0.15 * 1e9
      });
      
      console.log(`📝 Bridge transaction submitted: ${tx.hash}`);
      
      // Wait for transaction confirmation
      console.log(`⏳ Waiting for transaction confirmation...`);
      const receipt = await tx.wait();
      console.log(`✅ Bridge transaction confirmed in block ${receipt.blockNumber}`);
      
      return { tx, receipt, requestId: depositStep.requestId };
    } catch (error) {
      console.error(`❌ Error executing bridge transaction: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check status of a bridge transaction
   * @param {string} requestId - Request ID from the quote
   * @returns {Promise<Object>} Status response
   */
  async checkBridgeStatus(requestId) {
    try {
      console.log(`🔍 Checking status of bridge transaction with request ID: ${requestId}...`);
      
      const response = await axios.get(`${relayService.apiUrl}/intents/status?requestId=${requestId}`, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`📊 Bridge status: ${response.data.status}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Error checking bridge status: ${error.message}`);
      if (error.response) {
        console.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  /**
   * Complete bridge flow from checking balances to executing transaction
   * @param {Wallet} wallet - Ethers.js wallet
   * @returns {Promise<Object>} Bridge result
   */
  async bridgeTokens(wallet) {
    try {
      console.log(`🚀 Starting token bridge process for wallet ${wallet.address}...`);
      
      // 1. Check token balances across all chains
      console.log(`👛 Step 1: Checking token balances across all chains...`);
      const balances = await this.checkTokenBalancesAcrossChains(wallet.address);
      
      // 2. Find best token to bridge
      console.log(`💰 Step 2: Finding best token to bridge...`);
      const bestToken = this.findBestTokenToBridge(balances);
      
      // 3. Find destination chain
      console.log(`🌉 Step 3: Finding destination chain...`);
      const destinationChainId = this.findDestinationChain(bestToken.sourceChainId);
      
      // 4. Calculate amount to bridge (50% of balance)
      const amountToBridge = bestToken.balance.div(2);
      console.log(`💸 Step 4: Will bridge ${ethers.utils.formatUnits(amountToBridge, balances[bestToken.sourceChainId][bestToken.symbol].decimals)} ${bestToken.symbol} (50% of balance)`);
      
      // 5. Request bridge quote
      console.log(`📝 Step 5: Requesting bridge quote...`);
      const quoteResponse = await this.requestBridgeQuote({
        user: wallet.address,
        recipient: wallet.address,
        originChainId: bestToken.sourceChainId,
        destinationChainId,
        tokenAddress: bestToken.tokenAddress,
        symbol: bestToken.symbol,
        amount: amountToBridge,
        slippageTolerance: "0.5"
      });
      
      // 6. Execute bridge transaction
      console.log(`🏦 Step 6: Executing bridge transaction...`);
      const bridgeResult = await this.executeBridgeTransaction(wallet, quoteResponse);
      
      // 7. Check initial status
      console.log(`🔍 Step 7: Checking initial bridge status...`);
      const initialStatus = await this.checkBridgeStatus(bridgeResult.requestId);
      
      console.log(`✅ Bridge process initiated successfully! Monitor status with request ID: ${bridgeResult.requestId}`);
      
      return {
        bestToken,
        destinationChainId,
        amountToBridge,
        quoteResponse,
        bridgeResult,
        initialStatus,
        requestId: bridgeResult.requestId
      };
    } catch (error) {
      console.error(`❌ Error in bridge process: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new BridgeService(); 