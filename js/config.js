/* EUTXO.DEX — global configuration
 * All public endpoints below were verified reachable + CORS-open on 2026-08-21.
 */
export const CONFIG = {
  app: {
    name: 'EUTXO.DEX',
    tagline: 'Own your swaps on Ergo',
    x: 'https://x.com/kshot9000',
    xHandle: '@kshot9000',
    version: '1.0.0',
  },

  networks: {
    mainnet: {
      id: 'mainnet',
      label: 'Mainnet',
      prefix: 'Mainnet',           // ergo-lib NetworkPrefix
      gateway: 'https://api.ergoplatform.com/api/v1',
      explorer: 'https://explorer.ergoplatform.com',
      explorerTx: (id) => `https://explorer.ergoplatform.com/transactions/${id}`,
      explorerAddr: (a) => `https://explorer.ergoplatform.com/addresses/${a}`,
      explorerToken: (t) => `https://explorer.ergoplatform.com/tokens/${t}`,
      coingeckoId: 'ergo',
    },
    testnet: {
      id: 'testnet',
      label: 'Testnet',
      prefix: 'Testnet',
      gateway: 'https://testnet.ergoplatform.com/api/v1', // probed at runtime; may be offline
      explorer: 'https://testnet.ergoplatform.com',
      explorerTx: (id) => `https://testnet.ergoplatform.com/transactions/${id}`,
      explorerAddr: (a) => `https://testnet.ergoplatform.com/addresses/${a}`,
      explorerToken: (t) => `https://testnet.ergoplatform.com/tokens/${t}`,
      coingeckoId: null,
    },
  },

  // Optional full node (needed for: wallet balances, real tx signing/broadcast, faucet).
  // Default points at a locally running ergo node; users can change it in Settings.
  node: {
    defaultMainnet: 'http://localhost:9053',
    defaultTestnet: 'http://localhost:9053',
    feeNano: '1100000',            // 0.0011 ERG — matches sigma-rust TxBuilder.SUGGESTED_TX_FEE()
  },

  // Popular / seeded tokens. ERG is the native coin (no token id).
  // LIT + USE are real Ergo tokens discovered via the public API.
  tokens: [
    { id: 'ERG', symbol: 'ERG', name: 'Ergo', decimals: 9, native: true, color: '#ff7a1a', icon: 'erg' },
    { id: 'c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7', symbol: 'LIT', name: 'LIT', decimals: 9, color: '#ff3b4d', icon: 'lit' },
    { id: '548a6819b987023f413beb3320deafe16f8d81ca4836aebed94bae9098a69201', symbol: 'USE', name: 'USE', decimals: 6, color: '#22c1a3', icon: 'use' },
  ],

  // Seeded virtual liquidity pools (nano units). Pools are local (demo) liquidity —
  // the AMM math is real constant-product; settlement is simulated until an
  // on-chain pool contract + full node are connected (see README roadmap).
  defaultPools: [
    { base: 'ERG', quote: 'c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7', rBase: '20000000000000', rQuote: '2000000000000000', feeBps: 30 },
    { base: 'ERG', quote: '548a6819b987023f413beb3320deafe16f8d81ca4836aebed94bae9098a69201', rBase: '5000000000000', rQuote: '5000000000', feeBps: 30 },
  ],

  // Donation wallets (public addresses — safe to ship in the app).
  donations: [
    {
      chain: 'ERG', label: 'Ergo (ERG)',
      address: '9fcM5RWnAjmP4vx5bnW6yohB6H9bLq8sJbaPLHtwZLtQPB32Pvy',
      view: (net) => `https://explorer.ergoplatform.com/addresses/9fcM5RWnAjmP4vx5bnW6yohB6H9bLq8sJbaPLHtwZLtQPB32Pvy`,
      color: '#ff7a1a',
    },
    {
      chain: 'BTC', label: 'Bitcoin (BTC)',
      address: '3GnR7TWBXAB3pPztBWpNF4LMNEX5yX8vZK',
      view: 'https://mempool.space/address/3GnR7TWBXAB3pPztBWpNF4LMNEX5yX8vZK',
      color: '#f7931a',
    },
    {
      chain: 'ADA', label: 'Cardano (ADA)',
      address: 'addr1q8hnl6vl5a6k3rw3n5g3jtte696zcl76kfatzv7gpswa9r0dj7fma6klq55y4ffm7tf0em09udnyhuk4ah92pl5x9jpqjae44v',
      view: 'https://cardanoscan.io/addresses/addr1q8hnl6vl5a6k3rw3n5g3jtte696zcl76kfatzv7gpswa9r0dj7fma6klq55y4ffm7tf0em09udnyhuk4ah92pl5x9jpqjae44v',
      color: '#2a5adb',
    },
  ],

  price: {
    coingecko: 'https://api.coingecko.com/api/v3/simple/price',
    refreshMs: 5 * 60 * 1000,
  },

  storage: {
    poolsKey: 'eutxo.pools.v1',
    activityKey: 'eutxo.activity.v1',
    settingsKey: 'eutxo.settings.v1',
    walletKey: 'eutxo.wallet.v1',
  },

  ui: {
    slippageOptions: [0.5, 1, 2, 5, 10],
    maxSlippage: 10,
    activityBlocks: 30, // how many recent blocks to scan for "active tokens"
  },
};
