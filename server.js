// ============================================
// BACKEND API SERVER (Node.js + Express)
// ============================================

const express = require('express');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const { ethers } = require('ethers');
//import { Web3 } from 'web3';
const { Web3 } = require('web3');

const app = express();
app.use(express.json());

// ============================================
// WALLET CONNECTIONS
// ============================================

// Solana Connection
const solanaConnection = new Connection(
  process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com'
);

// Ethereum Provider
const ethProvider = new ethers.JsonRpcProvider(
  process.env.ETH_RPC || 'https://eth-mainnet.g.alchemy.com/v2/-0CNM3ZU_1wtIHlJ-wrGQm1qiQMGR1s0'
);

// BSC Provider
const bscWeb3 = new Web3(
  process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/'
);

// ============================================
// MULTI-CHAIN WALLET MANAGER
// ============================================

class WalletManager {
  constructor() {
    this.wallets = {
      solana: null,
      ethereum: null,
      bsc: null
    };
    this.initializeWallets();
  }

  initializeWallets() {
    // Initialize from environment variables or secure storage
    if (process.env.SOLANA_PRIVATE_KEY) {
      // Solana wallet setup
      const solanaKeypair = require('@solana/web3.js').Keypair.fromSecretKey(
        Buffer.from(process.env.SOLANA_PRIVATE_KEY, 'hex')
      );
      this.wallets.solana = solanaKeypair;
    }

    if (process.env.ETH_PRIVATE_KEY) {
      // Ethereum wallet setup
      this.wallets.ethereum = new ethers.Wallet(
        process.env.ETH_PRIVATE_KEY,
        ethProvider
      );
    }

    if (process.env.BSC_PRIVATE_KEY) {
      // BSC wallet setup
      this.wallets.bsc = bscWeb3.eth.accounts.privateKeyToAccount(
        process.env.BSC_PRIVATE_KEY
      );
      bscWeb3.eth.accounts.wallet.add(this.wallets.bsc);
    }
  }

  getWallet(chain) {
    return this.wallets[chain];
  }
}

const walletManager = new WalletManager();

// ============================================
// TRADING EXECUTOR
// ============================================

class TradeExecutor {
  
  // Execute Buy Order
  async executeBuy(params) {
    const { chain, tokenAddress, amount, slippage, antiMevDelay } = params;
    
    // Anti-MEV: Random delay
    await this.sleep(antiMevDelay);
    
    switch(chain) {
      case 'solana':
        return await this.buySolana(tokenAddress, amount, slippage);
      case 'ethereum':
        return await this.buyEthereum(tokenAddress, amount, slippage);
      case 'bsc':
        return await this.buyBSC(tokenAddress, amount, slippage);
      default:
        throw new Error('Unsupported chain');
    }
  }

  // Solana Buy Implementation
  async buySolana(tokenAddress, amount, slippage) {
    const wallet = walletManager.getWallet('solana');
    
    // Jupiter aggregator for best rates
    const jupiterQuoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${amount * 1e9}&slippageBps=${slippage * 100}`;
    
    const quoteResponse = await fetch(jupiterQuoteUrl);
    const quoteData = await quoteResponse.json();
    
    // Get swap transaction
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 1000000 // Priority fee for faster execution
      })
    });
    
    const { swapTransaction } = await swapResponse.json();
    const transactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = Transaction.from(transactionBuf);
    
    // Sign and send transaction
    const signature = await solanaConnection.sendTransaction(transaction, [wallet], {
      skipPreflight: false,
      maxRetries: 3
    });
    
    await solanaConnection.confirmTransaction(signature, 'confirmed');
    
    return {
      success: true,
      transactionHash: signature,
      executionPrice: quoteData.outAmount / quoteData.inAmount,
      chainId: 'solana',
      tokenAddress
    };
  }

  // Ethereum Buy Implementation (Uniswap V2/V3)
  async buyEthereum(tokenAddress, amount, slippage) {
    const wallet = walletManager.getWallet('ethereum');
    
    // Uniswap V2 Router
    const uniswapRouter = new ethers.Contract(
      '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
      [
        'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
        'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
      ],
      wallet
    );
    
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const path = [WETH, tokenAddress];
    
    // Get expected output
    const amounts = await uniswapRouter.getAmountsOut(
      ethers.parseEther(amount.toString()),
      path
    );
    
    const amountOutMin = amounts[1] * BigInt(100 - slippage) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes
    
    // Execute swap with high gas price for speed
    const gasPrice = await ethProvider.getFeeData();
    const tx = await uniswapRouter.swapExactETHForTokens(
      amountOutMin,
      path,
      wallet.address,
      deadline,
      {
        value: ethers.parseEther(amount.toString()),
        gasLimit: 300000,
        maxFeePerGas: gasPrice.maxFeePerGas * 2n, // 2x for faster execution
        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas * 2n
      }
    );
    
    const receipt = await tx.wait();
    
    return {
      success: true,
      transactionHash: receipt.hash,
      executionPrice: Number(amounts[1]) / Number(amounts[0]),
      chainId: 'ethereum',
      tokenAddress
    };
  }

  // BSC Buy Implementation (PancakeSwap)
  async buyBSC(tokenAddress, amount, slippage) {
    const wallet = walletManager.getWallet('bsc');
    
    const pancakeRouter = new bscWeb3.eth.Contract(
      [
        {
          "inputs": [
            {"internalType": "uint256","name": "amountOutMin","type": "uint256"},
            {"internalType": "address[]","name": "path","type": "address[]"},
            {"internalType": "address","name": "to","type": "address"},
            {"internalType": "uint256","name": "deadline","type": "uint256"}
          ],
          "name": "swapExactETHForTokens",
          "outputs": [{"internalType": "uint256[]","name": "amounts","type": "uint256[]"}],
          "stateMutability": "payable",
          "type": "function"
        },
        {
          "inputs": [
            {"internalType": "uint256","name": "amountIn","type": "uint256"},
            {"internalType": "address[]","name": "path","type": "address[]"}
          ],
          "name": "getAmountsOut",
          "outputs": [{"internalType": "uint256[]","name": "amounts","type": "uint256[]"}],
          "stateMutability": "view",
          "type": "function"
        }
      ],
      '0x10ED43C718714eb63d5aA57B78B54704E256024E' // PancakeSwap V2 Router
    );
    
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const path = [WBNB, tokenAddress];
    
    const amountIn = bscWeb3.utils.toWei(amount.toString(), 'ether');
    const amounts = await pancakeRouter.methods.getAmountsOut(amountIn, path).call();
    
    const amountOutMin = (BigInt(amounts[1]) * BigInt(100 - slippage)) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
    
    const gasPrice = await bscWeb3.eth.getGasPrice();
    const tx = pancakeRouter.methods.swapExactETHForTokens(
      amountOutMin.toString(),
      path,
      wallet.address,
      deadline
    );
    
    const receipt = await tx.send({
      from: wallet.address,
      value: amountIn,
      gas: 300000,
      gasPrice: (BigInt(gasPrice) * 2n).toString() // 2x for speed
    });
    
    return {
      success: true,
      transactionHash: receipt.transactionHash,
      executionPrice: Number(amounts[1]) / Number(amounts[0]),
      chainId: 'bsc',
      tokenAddress
    };
  }

  // Execute Sell Order
  async executeSell(params) {
    const { chain, tokenAddress, positionId, slippage, partialSell } = params;
    
    // Implement sell logic similar to buy but in reverse
    // If partialSell is true, sell only 50% of holdings
    
    // Implementation would mirror buy logic but swap tokens for native currency
    return {
      success: true,
      transactionHash: 'sell_tx_hash',
      executionPrice: 0,
      chainId: chain
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const tradeExecutor = new TradeExecutor();

// ============================================
// API ENDPOINTS
// ============================================

app.post('/api/execute-trade', async (req, res) => {
  try {
    const { action, ...params } = req.body;
    
    let result;
    if (action === 'buy') {
      result = await tradeExecutor.executeBuy(params);
    } else if (action === 'sell') {
      result = await tradeExecutor.executeSell(params);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Trade execution error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', wallets: Object.keys(walletManager.wallets) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trading API running on port ${PORT}`);
});

// ============================================
// DATABASE SCHEMA (PostgreSQL)
// ============================================

/*
CREATE TABLE active_positions (
  id SERIAL PRIMARY KEY,
  positionId VARCHAR(255) UNIQUE NOT NULL,
  tokenAddress VARCHAR(255) NOT NULL,
  chain VARCHAR(50) NOT NULL,
  entryPrice DECIMAL(20, 10) NOT NULL,
  stopLoss DECIMAL(20, 10) NOT NULL,
  takeProfit DECIMAL(20, 10) NOT NULL,
  lastSellPrice DECIMAL(20, 10),
  closed BOOLEAN DEFAULT FALSE,
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_active_positions_closed ON active_positions(closed);
CREATE INDEX idx_active_positions_chain ON active_positions(chain);
CREATE INDEX idx_active_positions_token ON active_positions(tokenAddress);

-- Trade history table
CREATE TABLE trade_history (
  id SERIAL PRIMARY KEY,
  positionId VARCHAR(255) NOT NULL,
  action VARCHAR(10) NOT NULL,
  tokenAddress VARCHAR(255) NOT NULL,
  chain VARCHAR(50) NOT NULL,
  price DECIMAL(20, 10) NOT NULL,
  amount DECIMAL(20, 10) NOT NULL,
  transactionHash VARCHAR(255) NOT NULL,
  profit_loss DECIMAL(10, 2),
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_history_position ON trade_history(positionId);
CREATE INDEX idx_trade_history_token ON trade_history(tokenAddress);
*/

// ============================================
// ENVIRONMENT VARIABLES NEEDED
// ============================================

/*
Required environment variables in .env file:

# API Keys
DEXSCREENER_API_KEY=your_key_here

# RPC Endpoints
SOLANA_RPC=https://api.mainnet-beta.solana.com
ETH_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
BSC_RPC=https://bsc-dataseed.binance.org/

# Private Keys (KEEP SECURE!)
SOLANA_PRIVATE_KEY=your_solana_private_key_hex
ETH_PRIVATE_KEY=0x_your_eth_private_key
BSC_PRIVATE_KEY=0x_your_bsc_private_key

# Trading Parameters
BUY_AMOUNT=0.1
DEFAULT_SLIPPAGE=15

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/trading_bot

# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Server
PORT=3000
*/
