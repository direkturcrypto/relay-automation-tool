require('dotenv').config();

module.exports = {
  // Flashloan contract address from .env
  FLASHLOAN_CONTRACT: process.env.FLASHLOAN_CONTRACT,
  
  // Configuration settings
  CONFIG: {
    // Set to true to randomly select from active swap configurations
    useRandomSwap: true,
    
    // Set to true to use random amount between minAmount and maxAmount
    useRandomAmount: true,
    
    // Number of seconds to wait between swaps if running multiple
    delayBetweenSwaps: 5,
    
    // Minimum and maximum delay (in seconds) between repeat transactions
    minDelaySeconds: parseInt(process.env.REPEAT_INTERVAL_MIN || '1', 10) * 60,
    maxDelaySeconds: parseInt(process.env.REPEAT_INTERVAL_MAX || '2', 10) * 60,
    
    // Max gas price in gwei to use for transactions
    maxGasPrice: 0.01,
    
    // Maximum acceptable total cost percentage (shortfall + fee, abort if exceeded)
    maxAcceptableShortfallPercentage: 2,
    
    // Percentage buffer to add to shortfall amount (helps prevent transaction failures)
    shortfallBufferPercentage: parseFloat(process.env.SHORTFALL_BUFFER_PERCENTAGE || '5')
  },
  
  // Token addresses on Base chain
  TOKEN_ADDRESSES: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    USDT: "0x7085d103c2eafDEa81e0d5D0eaf447D00D387500"
  },
  
  // Router addresses
  RELAY_ROUTER: "0xaaaaaaae92cc1ceef79a038017889fdd26d23d4d"
}
