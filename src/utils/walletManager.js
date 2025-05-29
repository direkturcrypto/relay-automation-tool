const fs = require('fs');
const { ethers } = require('ethers');
require('dotenv').config();

/**
 * Utility for managing wallets
 */
class WalletManager {
  /**
   * Load wallets from JSON file
   * @returns {Array} Array of wallet objects
   */
  loadWallets() {
    try {
      const walletFile = process.env.WALLET_FILE || 'wallets.json';
      console.log(`📂 Loading wallets from ${walletFile}...`);
      
      if (!fs.existsSync(walletFile)) {
        console.error(`❌ Wallet file ${walletFile} not found`);
        throw new Error(`Wallet file ${walletFile} not found`);
      }
      
      const walletData = fs.readFileSync(walletFile, 'utf8');
      const wallets = JSON.parse(walletData);
      
      if (!Array.isArray(wallets) || wallets.length === 0) {
        console.error('❌ No wallets found in wallet file');
        throw new Error('No wallets found in wallet file');
      }
      
      // Validate wallet data
      wallets.forEach((wallet, index) => {
        if (!wallet.address || !wallet.privateKey) {
          console.error(`❌ Invalid wallet data at index ${index}`);
          throw new Error(`Invalid wallet data at index ${index}`);
        }
        
        // Set active to true by default if not specified
        if (wallet.active === undefined) {
          wallet.active = true;
        }
      });
      
      console.log(`✅ Successfully loaded ${wallets.length} wallets`);
      return wallets;
    } catch (error) {
      console.error(`❌ Error loading wallets: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Initialize wallet with provider
   * @param {string} privateKey - Private key
   * @param {Provider} provider - Ethers.js provider
   * @returns {Wallet} Ethers.js wallet
   */
  initializeWallet(privateKey, provider) {
    try {
      return new ethers.Wallet(privateKey, provider);
    } catch (error) {
      console.error(`❌ Error initializing wallet: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get random active wallet
   * @param {Array} wallets - Array of wallet objects
   * @param {Provider} provider - Ethers.js provider
   * @returns {Wallet} Ethers.js wallet
   */
  getRandomActiveWallet(wallets, provider) {
    try {
      const activeWallets = wallets.filter(wallet => wallet.active);
      
      if (activeWallets.length === 0) {
        throw new Error('No active wallets found');
      }
      
      const randomWallet = activeWallets[Math.floor(Math.random() * activeWallets.length)];
      return this.initializeWallet(randomWallet.privateKey, provider);
    } catch (error) {
      console.error(`❌ Error getting random active wallet: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new WalletManager();
