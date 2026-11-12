'use strict'
const { HDNodeWallet } = require('ethers')
const { mnemonicToSeedSync, validateMnemonic } = require('@scure/bip39')
const { wordlist } = require('@scure/bip39/wordlists/english')
const { hmac } = require('@noble/hashes/hmac')
const { sha512 } = require('@noble/hashes/sha512')
const { ed25519 } = require('@noble/curves/ed25519')
const { base58 } = require('@scure/base')
const { NETWORKS } = require('./networks.cjs')
function keyFor(network, mnemonic) {
  if (!NETWORKS[network] || typeof mnemonic !== 'string' || !validateMnemonic(mnemonic, wordlist)) throw Error('Invalid wallet key material')
  if (network !== 'solana') {
    const key = HDNodeWallet.fromPhrase(mnemonic, '', NETWORKS[network].path)
    if (network === 'tron') {
      const { TronWeb } = require('tronweb')
      return { address: TronWeb.address.fromPrivateKey(key.privateKey.slice(2)), privateKey: key.privateKey.slice(2) }
    }
    return key
  }
  const seed = mnemonicToSeedSync(mnemonic)
  let digest = hmac(sha512, Buffer.from('ed25519 seed'), seed)
  seed.fill(0)
  for (const index of [44, 501, 0, 0]) {
    const data = Buffer.alloc(37); data.set(digest.subarray(0, 32), 1); data.writeUInt32BE(index + 0x80000000, 33)
    const next = hmac(sha512, digest.subarray(32), data)
    digest.fill(0); data.fill(0); digest = next
  }
  const secret = digest.slice(0, 32); digest.fill(0)
  return { address: base58.encode(ed25519.getPublicKey(secret)), secret }
}
function derive(network, mnemonic) {
  const key = keyFor(network, mnemonic)
  try { return key.address } finally { key.secret?.fill(0) }
}
module.exports = { keyFor, derive }
