const axios = require('axios');
require('dotenv').config();

/**
 * Service for interacting with Relay API
 */
class RelayService {
  constructor() {
    this.apiUrl = process.env.RELAY_API_URL || 'https://api.relay.link';
  }

  /**
   * Request a quote from Relay API
   * @param {Object} params - Quote parameters
   * @param {string} params.originChainId - Origin chain ID
   * @param {string} params.destinationChainId - Destination chain ID
   * @param {string} params.originCurrency - Origin token address
   * @param {string} params.destinationCurrency - Destination token address
   * @param {string} params.amount - Amount to swap (in wei)
   * @param {string} params.user - User address
   * @param {string} params.recipient - Recipient address
   * @param {string} params.slippageTolerance - Slippage tolerance percentage
   * @returns {Promise<Object>} Quote response
   */
  async requestQuote(params) {
    try {
      console.log(`🔍 Requesting quote from Relay API...`);
      
      // Convert slippage tolerance to integer string (e.g., "50" for 0.5%)
      const slippageInt = Math.round(parseFloat(params.slippageTolerance || "0.5") * 100).toString();
      
      const requestData = {
        user: params.user,
        recipient: params.recipient,
        originChainId: params.originChainId,
        destinationChainId: params.destinationChainId,
        originCurrency: params.originCurrency,
        destinationCurrency: params.destinationCurrency,
        amount: params.amount,
        tradeType: "EXACT_INPUT",
        referrer: "relay.link",
        slippageTolerance: slippageInt // Integer string as required by API
      };
      
      // console.log(`📤 Request data: ${JSON.stringify(requestData, null, 2)}`);
      
      const response = await axios.post(`${this.apiUrl}/quote`, requestData, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`📥 Received quote response with status: ${response.status}`);
      
      if (response.status !== 200) {
        throw new Error(`Relay API returned status ${response.status}`);
      }
      
      return response;
    } catch (error) {
      console.error(`❌ Error requesting quote from Relay API: ${error.message}`);
      if (error.response) {
        console.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }
}

module.exports = new RelayService();
