'use strict'
const { setTimeout: delay } = require('node:timers/promises')
const https = require('node:https')
const { Readable } = require('node:stream')
// An address-family race can expire both IPv4 candidates before a delayed TCP
// retransmission succeeds (observed after 4 s with the old 2 s attempt limit).
// Allow the 1 s/3 s retransmissions within each attempt. The transport's shared
// 18 s/30 s deadline still bounds the entire request, retries and response body.
const agent = new https.Agent({ keepAlive: true, maxSockets: 4, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 5000 })
function httpsFetch(url, options) {
  if (new URL(url).protocol !== 'https:') return Promise.reject(Error('HTTPS is required'))
  return new Promise((resolve, reject) => {
    const request = https.request(url, { agent, method: options.method, signal: options.signal,
      headers: { ...options.headers, 'Accept-Encoding': 'identity' } }, response => {
      try {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        // Redirects remain ordinary non-success responses, never followed.
        const empty = [204, 205, 304].includes(response.statusCode)
        if (empty) response.resume()
        resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers }))
      } catch (error) { response.destroy(); reject(error) }
    })
    request.on('error', reject)
    request.end(options.body)
  })
}
const ENDPOINTS = Object.freeze({
  ethereum: 'https://ethereum-rpc.publicnode.com', bsc: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com', arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  solana: 'https://solana-rpc.publicnode.com', tron: 'https://tron-rpc.publicnode.com',
})
const EVM_READS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_syncing', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBlockReceipts', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  'eth_getLogs', 'eth_call', 'eth_getCode', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas'])
const SOL_READS = new Set(['getVersion', 'getGenesisHash', 'getSlot', 'getBlockHeight', 'getBalance', 'getLatestBlockhash',
  'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getTokenSupply', 'getTokenAccountBalance',
  'getMinimumBalanceForRentExemption', 'getFeeForMessage', 'getRecentPrioritizationFees', 'simulateTransaction',
  'getSignaturesForAddress', 'getTransaction', 'getSignatureStatuses'])
const TRON_READS = new Set(['/wallet/getnowblock', '/wallet/getblock', '/wallet/getblockbynum', '/wallet/getaccount', '/wallet/getaccountresource',
  '/wallet/getaccountnet', '/wallet/getchainparameters', '/wallet/triggerconstantcontract', '/wallet/estimateenergy',
  '/wallet/getcontract', '/wallet/gettransactionbyid', '/wallet/gettransactioninfobyid', '/wallet/getassetissuebyid',
  '/walletsolidity/getnowblock', '/walletsolidity/getblock', '/walletsolidity/getaccount', '/walletsolidity/triggerconstantcontract'])
class RpcError extends Error {
  constructor(message, code, retryable = false) { super(message); this.name = 'RpcError'; this.code = code; this.retryable = retryable }
}
function parseJson(text) {
  // Node 24 / Electron 43 expose the original numeric lexeme. Preserve large
  // Solana/Tron integers before IEEE-754 rounding can affect a balance.
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?\d+$/.test(context.source)) throw new RpcError('RPC returned an unsafe integer', 'INVALID_DATA')
      return context.source
    }
    return value
  })
}
async function responseBytes(response, limit) {
  if (!response.body) throw new RpcError('PublicNode returned an empty response', 'INVALID_DATA')
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new RpcError('RPC response exceeds the limit', 'SIZE') }
  const reader = response.body.getReader(), chunks = []; let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) { await reader.cancel(); throw new RpcError('RPC response exceeds the limit', 'SIZE') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}
function createTransport(network, { fetchImpl = httpsFetch, timeoutMs = 20000, contractTimeoutMs = timeoutMs, attempts = 2, sleep = delay } = {}) {
  const base = ENDPOINTS[network]
  if (!base) throw Error('Unknown PublicNode network')
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isInteger(contractTimeoutMs) || contractTimeoutMs < 1 || contractTimeoutMs > 30000) throw Error('Invalid RPC request limits')
  let serial = 0
  async function post(route, body, retry, budgetMs = timeoutMs) {
    const limit = 8 * 1024 * 1024
    // Retries share a deadline so a degraded RPC cannot multiply the module's
    // IPC timeout. A broadcast still has exactly one attempt.
    const deadline = Date.now() + budgetMs
    for (let attempt = 0; attempt < (retry ? attempts : 1); attempt++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new RpcError('PublicNode request timed out', 'NETWORK', true)
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining)
      let pause = Math.min(250 * 2 ** attempt, 2000)
      try {
        const response = await fetchImpl(base + route, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'AltbaseWallet/0.1.13' }, body: JSON.stringify(body) })
        if (!response.ok) {
          let upstream
          try { upstream = parseJson(await responseBytes(response, 4096)) } catch { /* Never expose an upstream HTML/error body. */ }
          if (response.status === 403 && typeof upstream?.error?.message === 'string' && /indexed requests require a personal token/i.test(upstream.error.message)) {
            throw new RpcError('PublicNode token discovery requires a personal access token', 'AUTH_REQUIRED')
          }
          const seconds = Number(response.headers.get('retry-after'))
          if (Number.isFinite(seconds) && seconds > 0) pause = Math.min(5000, seconds * 1000)
          // PublicNode also returns nonstandard HTTP 529 during overload.
          // Only read calls can retry, within the same shared deadline.
          throw new RpcError(`PublicNode returned HTTP ${response.status}`, response.status, [429, 502, 503, 504, 529].includes(response.status))
        }
        const text = await responseBytes(response, limit)
        try { return parseJson(text) }
        catch (error) { if (error instanceof RpcError) throw error; throw new RpcError('PublicNode returned invalid JSON', 'INVALID_DATA') }
      } catch (cause) {
        const error = cause instanceof RpcError ? cause : new RpcError(controller.signal.aborted ? 'PublicNode request timed out' : 'PublicNode connection failed', 'NETWORK', true)
        if (!retry || !error.retryable || attempt + 1 >= attempts) throw error
      } finally { clearTimeout(timer) }
      if (deadline - Date.now() <= pause) throw new RpcError('PublicNode request timed out', 'NETWORK', true)
      await sleep(pause)
    }
    throw new RpcError('PublicNode is unavailable', 'NETWORK')
  }
  async function jsonRpc(method, params, retry) {
    const id = ++serial, result = await post('', { jsonrpc: '2.0', id, method, params }, retry,
      retry && method === 'eth_call' ? contractTimeoutMs : timeoutMs)
    if (!result || result.id !== id || result.jsonrpc !== '2.0') throw new RpcError('Invalid RPC response identity', 'INVALID_DATA')
    if (result.error) {
      const code = result.error.code
      throw new RpcError(code === -32701 ? 'PublicNode requires a token contract filter for this query' : `PublicNode ${method} failed (${Number.isInteger(code) ? code : 'RPC'})`, code)
    }
    if (!Object.hasOwn(result, 'result')) throw new RpcError('Incomplete RPC response', 'INVALID_DATA')
    return result.result
  }
  return {
    network, url: base,
    async rpc(method, params = []) {
      if (!(network === 'solana' ? SOL_READS : network === 'tron' ? new Set() : EVM_READS).has(method)) throw Error('Only read RPC methods are allowed')
      return jsonRpc(method, params, true)
    },
    async tron(route, params = {}) {
      if (network !== 'tron' || !TRON_READS.has(route)) throw Error('Only read Tron methods are allowed')
      const result = await post(route, params, true)
      if (!result || typeof result !== 'object' || result.Error || result.error) throw new RpcError('Tron node rejected the read request', 'RPC')
      return result
    },
    // Used only by an explicit wallet confirmation. Never retries an uncertain
    // submission; the caller must reconcile its locally computed transaction ID.
    async broadcast(serialized) {
      if (network === 'tron') return post('/wallet/broadcasttransaction', serialized, false)
      return jsonRpc(network === 'solana' ? 'sendTransaction' : 'eth_sendRawTransaction',
        network === 'solana' ? [serialized, { encoding: 'base64', skipPreflight: false, maxRetries: 0 }] : [serialized], false)
    },
  }
}
module.exports = { ENDPOINTS, RpcError, parseJson, createTransport, httpsFetch }
