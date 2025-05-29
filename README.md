# Relay Cross-Chain Bridge Bot

This is an automated cross-chain cryptocurrency bridge bot that efficiently moves funds between multiple chains (Base, Arbitrum, Optimism, and Linea) using the Relay protocol. The bot helps users bridge tokens across chains while maintaining a wash-trading pattern, which can be beneficial for participation in various DeFi programs.

## Features

- **Multi-Chain Support**: Bridges between Base, Arbitrum, Optimism, and Linea networks
- **Token Swapping**: Uses 1inch API to swap tokens before bridging
- **Automated Bridging**: Uses Relay API to bridge tokens between chains
- **Gas Management**: Automatically bridges ETH for gas when needed
- **Wallet Management**: Supports multiple wallets with wallet generation and top-up functionality
- **Withdrawal Tool**: Easily withdraw all funds from generated wallets to a specified address

## Project Structure

```
relay-bot/
├── scripts/               # Main executable scripts
│   ├── bridge.js          # Main bridge bot script
│   ├── generate.js        # Wallet generation script
│   ├── topup.js           # Wallet top-up script
│   └── withdraw.js        # Funds withdrawal script
├── src/
│   ├── config/            # Configuration files
│   │   ├── config.js      # Configuration loader
│   │   └── constants.js   # Constants and settings
│   ├── services/          # Service modules
│   │   ├── bridgeService.js  # Bridge service for cross-chain transfers
│   │   └── relayService.js   # Relay API service
│   └── utils/             # Utility functions
│       ├── ethereum.js     # Ethereum-related utilities
│       └── walletManager.js # Wallet management utilities
├── .env                   # Environment variables (to be created)
├── .env.example          # Example environment file
├── package.json          # NPM package configuration
├── wallets.json          # Wallets data (to be created)
└── wallets.json.example  # Example wallets file
```

## Installation on Ubuntu VPS

Follow these step-by-step instructions to set up the bot on your Ubuntu VPS:

### 1. Update System and Install Dependencies

```bash
# Update your system
sudo apt update && sudo apt upgrade -y

# Install Node.js and npm
sudo apt install -y nodejs npm git

# Update to a newer Node.js version
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 22

# Verify installation
nvm current
node -v  # Should show v22.x.x
npm -v   # Should show 22.x.x or higher
```

### 2. Clone Repository and Install Dependencies

```bash
# Create a directory for the project
mkdir -p ~/relay-bot && cd ~/relay-bot

# Clone the repository
git clone https://github.com/direkturcrypto/relay-automation-tool .

# Install dependencies
npm install
```

### 3. Configure Environment Variables

```bash
# Create .env file from example
cp .env.example .env

# Edit the .env file with your configuration
nano .env
```

Fill in the following details in your .env file:

```
# RPC URLs
BASE_RPC_URL=https://base.llamarpc.com
ARBITRUM_RPC_URL=https://arbitrum.llamarpc.com
OPTIMISM_RPC_URL=https://optimism.llamarpc.com
LINEA_RPC_URL=https://linea.llamarpc.com

# Configuration
SLIPPAGE_TOLERANCE=0.5
REPEAT_INTERVAL_MIN=1
REPEAT_INTERVAL_MAX=5
```

### 4. Generate Wallets (Optional)

If you need to generate new wallets:

```bash
# Run the wallet generator
node scripts/generate.js
```

Follow the prompts to create wallets and optionally fund them with ETH and WETH.

### 5. Using Existing Wallets

If you already have wallets:

```bash
# Create wallets.json file
nano wallets.json
```

Add your wallets in the following format:

```json
[
  {
    "address": "0x123abc...",
    "privateKey": "0xabcdef...",
    "active": true
  },
  {
    "address": "0x456def...",
    "privateKey": "0xghijkl...",
    "active": true
  }
]
```

### 6. Run the Bot

```bash
# Start the bridge bot
node scripts/bridge.js
```

To keep the bot running even after closing your SSH session, use `screen` or `pm2`:

**Using screen:**
```bash
# Install screen
sudo apt install screen

# Create a new screen session
screen -S relay-bot

# Run the bot
node scripts/bridge.js

# Detach from screen (keep bot running in background)
# Press Ctrl+A then D

# To reattach to the screen session later
screen -r relay-bot
```

**Using pm2:**
```bash
# Install pm2
sudo npm install -g pm2

# Start the bot with pm2
pm2 start scripts/bridge.js --name relay-bot

# Check status
pm2 status

# View logs
pm2 logs relay-bot

# Stop the bot
pm2 stop relay-bot
```

## How It Works

The Relay Bridge Bot operates through several key mechanisms:

### 1. Bridge Cycle Process

Each bridge cycle follows these steps:

1. **Check Balances**: The bot checks token balances (ETH, WETH, USDC) across all supported chains.
2. **Find Best Token**: The bot identifies which token and chain have sufficient balance to bridge.
3. **Gas Check**: Ensures there's enough ETH for gas on the source chain. If not, it bridges ETH from Base chain.
4. **Token Swap**: Before bridging, the bot swaps tokens using 1inch API:
   - If WETH is found, it swaps to USDC
   - If USDC is found, it swaps to WETH
5. **Bridge Transaction**: Uses Relay API to bridge the swapped tokens to the destination chain.
6. **Verification**: Monitors the bridge status and waits for completion.

### 2. Token Strategy

The bot always bridges to the opposite token:
- When bridging WETH, it swaps to USDC first, then bridges USDC
- When bridging USDC, it swaps to WETH first, then bridges WETH

This creates a consistent pattern of cross-chain token swaps.

### 3. Gas Management

The bot has a sophisticated gas management system:
- Automatically detects when a chain is low on ETH for gas
- Bridges a small amount of ETH from Base chain to any chain that needs gas
- Keeps track of gas usage to ensure transactions can complete

## Additional Tools

### Top-up Wallets

To add more funds to your wallets:

```bash
node scripts/topup.js
```

### Withdraw All Funds

To withdraw all funds from all wallets to a single address:

```bash
node scripts/withdraw.js
```

## Troubleshooting

- **Insufficient Gas**: If you see errors about insufficient gas, run the `topup.js` script to add more ETH to your wallets.
- **API Errors**: Verify your API keys are correct in the .env file.
- **Failed Transactions**: Check that the wallet has sufficient balance and that gas prices aren't too high.
- **RPC Connection Issues**: Try updating the RPC URLs in your .env file to more reliable endpoints.

## Security Considerations

- **Private Keys**: Never share your wallets.json file or .env file.
- **Server Security**: Ensure your VPS has proper firewall rules and security measures.
- **Regular Backups**: Keep backups of your wallets.json file in a secure location.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
