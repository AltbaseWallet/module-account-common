'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib')
const { PNG } = require('pngjs')
const { getAddress } = require('ethers'), { base58 } = require('@scure/base')
const { httpsFetch } = require('./publicnode.cjs')
const FOLDERS = { ethereum: 'ethereum', bsc: 'smartchain', polygon: 'polygon', arbitrum: 'arbitrum', solana: 'solana', tron: 'tron' }
const MAX_BYTES = 256 * 1024
function iconIdentity(network, asset) {
  if (!FOLDERS[network] || typeof asset !== 'string') throw Error('Invalid token icon identity')
  let canonical
  if (['ethereum', 'bsc', 'polygon', 'arbitrum'].includes(network)) canonical = getAddress(asset)
  else if (network === 'solana') {
    if (base58.decode(asset).length !== 32) throw Error('Invalid mint address')
    canonical = asset
  } else if (/^trc10:[1-9]\d{0,15}$/.test(asset)) canonical = asset.slice(6)
  else {
    const { TronWeb } = require('tronweb')
    if (!TronWeb.isAddress(asset)) throw Error('Invalid Tron contract')
    canonical = TronWeb.address.fromHex(TronWeb.address.toHex(asset))
  }
  const key = crypto.createHash('sha256').update(network + ':' + canonical).digest('hex')
  return { key, canonical, url: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${FOLDERS[network]}/assets/${canonical}/logo.png` }
}
function sanitizePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error('Invalid PNG icon')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 512 || height > 512) throw Error('Icon dimensions exceed the limit')
  let offset = 8, headers = 0, ended = false; const compressed = []
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
    if (size > MAX_BYTES || offset + size + 12 > bytes.length || ended) throw Error('Invalid PNG chunk')
    if (type === 'IHDR' && ++headers !== 1) throw Error('Duplicate PNG header')
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + size))
    if (type === 'IEND') { if (size !== 0) throw Error('Invalid PNG end'); ended = true }
    offset += size + 12
  }
  if (!ended || offset !== bytes.length || !compressed.length) throw Error('Incomplete PNG icon')
  // Bound the decompressed stream BEFORE pngjs, including its interlaced path.
  zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: width * height * 8 + height * 7 + 4096 })
  const decoded = PNG.sync.read(bytes, { checkCRC: true })
  if (decoded.width !== width || decoded.height !== height) throw Error('PNG dimensions changed')
  return encodePixels(decoded)
}
function encodePixels(decoded) {
  const { width, height } = decoded
  const scale = Math.min(1, 128 / Math.max(width, height))
  const output = new PNG({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
  for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
    const from = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4
    decoded.data.copy(output.data, (y * output.width + x) * 4, from, from + 4)
  }
  // Re-encode pixels only. Never render remote SVG, HTML, metadata or URLs.
  return PNG.sync.write(output, { colorType: 6, bitDepth: 8 })
}
function sanitizeImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw Error('Invalid icon bytes')
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const decoded = require('jpeg-js').decode(bytes, { formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 0.3, maxMemoryUsageInMB: 32 })
    if (decoded.width > 512 || decoded.height > 512) throw Error('Icon dimensions exceed the limit')
    return encodePixels(decoded)
  }
  return sanitizePng(bytes)
}
function createIconCache(network, dataDirectory, { fetchImpl = httpsFetch, timeoutMs = 10000 } = {}) {
  const directory = path.join(dataDirectory, 'token-icons'), pending = new Map(), checked = new Map()
  function peek(asset) {
    try {
      const { key } = iconIdentity(network, asset), filename = path.join(directory, key + '.png')
      if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== path.join(fs.realpathSync(dataDirectory), 'token-icons')) return
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || stat.size < 45) return
      const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      if (checked.get(key)?.stamp === stamp) return checked.get(key).icon
      sanitizePng(fs.readFileSync(filename))
      const icon = { key, status: 'cached', source: 'local-cache', revision: crypto.createHash('sha256').update(stamp).digest('hex').slice(0, 16) }
      checked.set(key, { stamp, icon }); return icon
    } catch { return undefined }
  }
  async function read(url, limit, deadline, accept) {
    const remaining = Math.min(timeoutMs, deadline - Date.now())
    if (remaining <= 0) throw Error('Icon deadline exceeded')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, redirect: 'error', headers: { Accept: accept, 'User-Agent': 'AltbaseWallet/0.1.10' } })
      if (response.status !== 200 || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel(); return null
      }
      if (!response.body) throw Error('Empty icon response')
      const reader = response.body.getReader(), chunks = []; let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > limit) { await reader.cancel(); throw Error('Icon response exceeds limit') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      return Buffer.concat(chunks)
    } finally { clearTimeout(timer) }
  }
  async function fetchIcon(asset) {
    const cached = peek(asset)
    if (cached) return cached
    const { key, canonical, url } = iconIdentity(network, asset), filename = path.join(directory, key + '.png')
    const deadline = Date.now() + Math.min(20000, timeoutMs * 4)
    let pixels, source
    try {
      try { const bytes = await read(url, MAX_BYTES, deadline, 'image/png,image/jpeg'); if (bytes) { pixels = sanitizeImage(bytes); source = 'trustwallet-assets' } } catch { /* Try another public logo source. */ }
      if (!pixels && !asset.startsWith('trc10:')) {
        try {
          // Only the public chain + contract are sent. Balances and metadata
          // still come exclusively from PublicNode; this API supplies images.
          const bytes = await read(`https://api.dexscreener.com/tokens/v1/${network}/${canonical}`, 1024 * 1024, deadline, 'application/json')
          const pairs = bytes ? JSON.parse(bytes.toString('utf8')) : []
          if (!Array.isArray(pairs) || pairs.length > 300) throw Error('Invalid logo lookup response')
          const urls = new Set()
          for (const pair of pairs) {
            if (!pair || pair.chainId !== network || !pair.info?.imageUrl) continue
            let image
            try {
              if (iconIdentity(network, pair.baseToken?.address).key !== key) continue
              image = new URL(pair.info.imageUrl)
            } catch { continue }
            if (image.protocol !== 'https:' || image.hostname !== 'cdn.dexscreener.com' || image.port || image.username || image.password || !/^\/cms\/images\/[a-zA-Z0-9_-]+$/.test(image.pathname)) continue
            image.search = '?width=128&height=128&fit=contain&quality=95&format=png'; image.hash = ''
            urls.add(image.href)
          }
          for (const image of [...urls].slice(0, 2)) {
            try { const bytes = await read(image, MAX_BYTES, deadline, 'image/png,image/jpeg'); if (bytes) { pixels = sanitizeImage(bytes); source = 'dexscreener-logo'; break } } catch { /* Try the next matching logo. */ }
          }
        } catch { /* A missing logo never invalidates the token itself. */ }
      }
      if (!pixels) return { key, status: 'unavailable' }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== path.join(fs.realpathSync(dataDirectory), 'token-icons')) throw Error('Invalid icon cache directory')
      const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
      try { fs.writeFileSync(temporary, pixels, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename) }
      finally { fs.rmSync(temporary, { force: true }) }
      const icon = peek(asset)
      if (!icon) throw Error('Cached icon failed validation')
      icon.source = source; return icon
    } catch { return { key, status: 'unavailable' } }
  }
  // No network activity on construction or cached reads. The runtime calls
  // load only for explicit imports and bounded recovery of those same imports.
  return { peek, load(asset) {
    const { key } = iconIdentity(network, asset)
    if (!pending.has(key)) pending.set(key, fetchIcon(asset).finally(() => pending.delete(key)))
    return pending.get(key)
  } }
}
module.exports = { iconIdentity, sanitizePng, sanitizeImage, createIconCache, MAX_BYTES }
