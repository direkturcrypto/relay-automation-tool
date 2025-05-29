# Building an Automated Cross-Chain Bridge Bot with Relay

## Introduction

In the rapidly evolving world of decentralized finance (DeFi), moving assets across different blockchain networks efficiently has become increasingly important. Cross-chain bridges enable this functionality, but using them manually can be time-consuming and prone to error, especially when working with multiple wallets or executing frequent transactions.

This article explores the development of an automated cross-chain bridge bot that leverages the Relay protocol to seamlessly move assets between four major Layer 2 networks: Base, Arbitrum, Optimism, and Linea. I'll discuss the architecture, key features, and technical implementation details to help you understand how such a system works.

## The Problem: Cross-Chain Complexity

Managing assets across multiple blockchain networks presents several challenges:

1. **Gas Management**: Each chain requires its native token (ETH) for gas fees
2. **Token Conversion**: Often you need to swap tokens before or after bridging
3. **Multiple Wallets**: Managing numerous wallets across chains is time-consuming
4. **Bridge Monitoring**: Bridges can take minutes to hours to complete
5. **Automation**: Executing bridging operations according to a schedule

To address these challenges, I developed an automated solution that handles the entire bridging process from end to end.

## Solution Architecture

The bot is built using Node.js and ethers.js, with a modular architecture that separates concerns into distinct components:

1. **Main Scripts**:
   - `bridge.js` - Core bridging logic
   - `generate.js` - Wallet generation utilities
   - `topup.js` - Wallet funding utilities
   - `withdraw.js` - Fund withdrawal utilities

2. **Services**:
   - `bridgeService.js` - Bridge operations via Relay API
   - `relayService.js` - Relay API integration

3. **Utilities**:
   - `ethereum.js` - Ethereum transaction handling
   - `walletManager.js` - Wallet management functions

This modular approach allows for easier maintenance and extension of functionality.

## Key Features

### 1. Multi-Chain Token Balance Management

The bot can check token balances across all supported chains and decide which tokens to bridge based on availability. This is implemented using a `checkTokenBalancesAcrossChains` function that:

- Connects to each chain via different RPC endpoints
- Checks ETH, WETH, and USDC balances on each chain
- Returns a comprehensive map of available assets

```javascript
async function checkTokenBalancesAcrossChains(walletAddress) {
  const balances = {};
  
  for (const [chainName, chainId] of Object.entries(chainIds)) {
    // Initialize provider for this chain
    const provider = new ethers.providers.JsonRpcProvider(rpcUrls[chainId]);
    
    // Check ETH and token balances
    // Store in the balances object
  }
  
  return balances;
}
```

### 2. Intelligent Swap and Bridge Strategy

The bot implements a unique strategy for token movement:

- When it finds WETH on any chain, it swaps to USDC before bridging
- When it finds USDC on any chain, it swaps to WETH before bridging

This creates a consistent pattern of alternating tokens across chains, which is useful for:
- Maintaining liquidity in both tokens
- Potentially benefiting from token price differences
- Creating natural "wash trading" volume

```javascript
function findBestTokenToBridge(balances) {
  // First check for WETH balance on any chain
  let sourceWETH = findTokenBalanceOnChains(balances, "WETH");
  if (sourceWETH) {
    return {
      ...sourceWETH,
      targetSymbol: "USDC" // Target is USDC
    };
  }
  
  // Then check for USDC balance on any chain
  let sourceUSDC = findTokenBalanceOnChains(balances, "USDC");
  if (sourceUSDC) {
    return {
      ...sourceUSDC,
      targetSymbol: "WETH" // Target is WETH
    };
  }
}
```

### 3. Automatic Gas Management

One of the most innovative features is the bot's ability to detect when a chain is low on ETH for gas and automatically bridge some from the Base chain:

```javascript
async function bridgeETHForGas(wallet, targetChainId) {
  // Connect to Base chain
  const baseProvider = new ethers.providers.JsonRpcProvider(rpcUrls[CHAIN_IDS.BASE]);
  const baseWallet = wallet.connect(baseProvider);
  
  // Check ETH balance on Base
  const baseETHBalance = await baseWallet.getBalance();
  
  // If sufficient, bridge ETH to target chain
  // This involves wrapping ETH to WETH, then using Relay to bridge
  // with destination currency set to native ETH
}
```

This ensures that wallets always have sufficient gas on any chain to execute transactions.

### 4. 1inch Integration for Token Swaps

The bot uses the 1inch API to execute token swaps efficiently:

```javascript
async function getQuote(account, receiver, from, to, amount, chainId) {
  const config = {
    url: `https://api.1inch.dev/swap/v6.0/${chainId}/swap`,
    params: {
      src: from,
      dst: to,
      amount: amount.toString(),
      from: account,
      receiver: receiver,
      slippage: 0.01,
      allowPartialFill: true,
      disableEstimate: true
    },
    headers: {
      'Authorization': `Bearer ${ONEINCH_API_KEY}`
    },
    method: 'GET'
  };

  const response = await axios(config);
  return response.data;
}
```

This integration allows for optimized swaps with features like:
- Custom slippage settings
- Fee configurations
- Referral system support

### 5. Wallet Management Tools

The bot comes with comprehensive wallet management utilities:

- **Generate Wallets**: Create new wallets and optionally fund them
- **Top-up Wallets**: Add ETH and tokens to existing wallets
- **Withdraw Funds**: Extract all funds from wallets to a single address

This makes it easy to set up, maintain, and eventually close out wallet operations.

## Technical Implementation Challenges

### Challenge 1: Gas Estimation

Accurately estimating gas for cross-chain operations is challenging. The solution involves:

1. Estimating gas requirements for the current operation
2. Adding a buffer (typically 20%)
3. Checking if the wallet has sufficient ETH
4. If not, bridging ETH specifically for gas from Base chain

```javascript
// Estimate gas before executing swap to catch insufficient funds early
const gasEstimate = await connectedWallet.estimateGas({
  to: swapQuote.tx.to,
  data: swapQuote.tx.data,
  value: swapQuote.tx.value ? ethers.BigNumber.from(swapQuote.tx.value) : ethers.BigNumber.from(0)
});

// Add 20% buffer to gas estimate
const gasLimit = gasEstimate.mul(120).div(100);
```

### Challenge 2: Bridging Status Monitoring

Cross-chain bridges don't complete instantly. The bot implements a monitoring system:

```javascript
// Check bridge status
const initialStatus = await bridgeService.checkBridgeStatus(bridgeResult.requestId);

// If still pending, the bot will check again later
if (initialStatus.status === 'pending' || initialStatus.status === 'created') {
  console.log(`⏳ Bridge transaction initiated but still pending. Will check status again later.`);
} else if (initialStatus.status === 'completed') {
  console.log(`✅ Bridge transaction completed successfully!`);
}
```

### Challenge 3: API Compatibility

The 1inch API occasionally changes its response structure. We implemented a compatibility layer:

```javascript
// Check for dstAmount (renamed from toAmount in new API version)
if (response.data.dstAmount) {
  console.log(`✅ Found dstAmount in response: ${response.data.dstAmount}`);
  // Map dstAmount to toAmount for compatibility with our code
  response.data.toAmount = response.data.dstAmount;
}
```

## Operational Workflow

The complete operational workflow of the bot is:

1. **Wallet Selection**: Randomly select an active wallet
2. **Balance Check**: Check token balances across all chains
3. **Strategy Selection**: Determine which token to bridge from which chain
4. **Gas Check**: Ensure sufficient ETH for gas, bridge if needed
5. **Token Swap**: Swap the source token to the target token using 1inch
6. **Bridge Setup**: Get a bridge quote from the Relay API
7. **Token Approval**: Approve the bridge contract to spend tokens
8. **Bridge Execution**: Execute the bridge transaction
9. **Status Monitoring**: Check bridge status and log results
10. **Wait Period**: Wait for a random interval before the next cycle

## Security Considerations

When operating a bot that handles cryptocurrency assets, security is paramount:

1. **Private Key Management**: Never expose wallet private keys
2. **RPC Security**: Use secure RPC endpoints
3. **Gas Limits**: Always set appropriate gas limits to prevent excessive fees
4. **Error Handling**: Implement comprehensive error handling
5. **Logging**: Maintain detailed logs for troubleshooting

## Conclusion

Building an automated cross-chain bridge bot requires addressing multiple technical challenges, from gas management to API integrations. The solution presented here demonstrates how to create a robust system that efficiently moves assets across chains while implementing intelligent strategies for token swaps.

This technology enables users to automate complex cross-chain operations, potentially saving time and reducing errors compared to manual bridging. As DeFi continues to expand across multiple blockchains, tools like this will become increasingly valuable for efficiently managing assets in a multi-chain ecosystem.

For those interested in implementing such a system, the full code is available on GitHub, complete with documentation on installation and configuration for your own use cases. 