const fs = require('fs');
require('dotenv').config();

/**
 * Configuration loader
 */
class ConfigLoader {
  /**
   * Load configuration from .env file
   * @returns {Object} Configuration object
   */
  loadConfig() {
    try {
      console.log('📝 Loading configuration from .env file...');
      
      const config = {
        RPC_URL: process.env.RPC_URL || 'https://base.llamarpc.com',
        FLASHLOAN_CONTRACT: process.env.FLASHLOAN_CONTRACT,
        RELAY_API_URL: process.env.RELAY_API_URL || 'https://api.relay.link',
        WALLET_FILE: process.env.WALLET_FILE || 'wallets.json',
        MIN_AMOUNT_ETH: process.env.MIN_AMOUNT_ETH || '0.01',
        MAX_AMOUNT_ETH: process.env.MAX_AMOUNT_ETH || '0.05',
        SLIPPAGE_TOLERANCE: process.env.SLIPPAGE_TOLERANCE || '0.5',
        REPEAT_INTERVAL_MIN: parseInt(process.env.REPEAT_INTERVAL_MIN || '1', 10),
        REPEAT_INTERVAL_MAX: parseInt(process.env.REPEAT_INTERVAL_MAX || '2', 10),
        SHORTFALL_BUFFER_PERCENTAGE: process.env.SHORTFALL_BUFFER_PERCENTAGE || '5'
      };
      
      // Validate required configuration
      if (!config.FLASHLOAN_CONTRACT) {
        throw new Error('FLASHLOAN_CONTRACT is required in .env file');
      }
      
      console.log('✅ Configuration loaded successfully');
      return config;
    } catch (error) {
      console.error(`❌ Error loading configuration: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new ConfigLoader();
