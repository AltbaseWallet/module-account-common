'use strict'
const NETWORKS = Object.freeze({
  ethereum: { name: 'Ethereum', ticker: 'ETH', decimals: 18, chainId: 1, path: "m/44'/60'/0'/0/0" },
  bsc: { name: 'BNB Smart Chain', ticker: 'BNB', decimals: 18, chainId: 56, path: "m/44'/60'/0'/0/0" },
  polygon: { name: 'Polygon', ticker: 'POL', decimals: 18, chainId: 137, path: "m/44'/60'/0'/0/0" },
  arbitrum: { name: 'Arbitrum One', ticker: 'ETH', decimals: 18, chainId: 42161, path: "m/44'/60'/0'/0/0" },
  solana: { name: 'Solana', ticker: 'SOL', decimals: 9, path: "m/44'/501'/0'/0'", genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
  tron: { name: 'Tron', ticker: 'TRX', decimals: 6, path: "m/44'/195'/0'/0/0", genesis: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc' },
})
module.exports = { NETWORKS }
