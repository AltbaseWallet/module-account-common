'use strict'
function precision(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw Error('Invalid asset precision')
  return value
}
function unsigned(value, { bits = 256 } = {}) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Unsafe atomic amount')
    value = String(value)
  }
  if (typeof value !== 'string' || value.length > 128 || !/^(?:0|[1-9]\d*)$/.test(value)) throw Error('Invalid atomic amount')
  const result = BigInt(value)
  if (!Number.isInteger(bits) || bits < 1 || bits > 512 || result >= 1n << BigInt(bits)) throw Error('Atomic amount exceeds its chain range')
  return result
}
function parseAmount(value, decimals, options) {
  precision(decimals)
  if (typeof value !== 'string' || value.length > 400 || !/^\d+(?:\.\d+)?$/.test(value)) throw Error('Enter a valid positive decimal amount')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.slice(decimals).replace(/0/g, '')) throw Error('Amount exceeds the asset precision')
  const digits = (whole + fraction.slice(0, decimals).padEnd(decimals, '0')).replace(/^0+(?=\d)/, '')
  return unsigned(digits, options)
}
function formatAmount(value, decimals) {
  precision(decimals)
  const digits = unsigned(typeof value === 'bigint' ? value.toString() : value).toString()
  if (!decimals) return digits
  const padded = digits.padStart(decimals + 1, '0'), tail = padded.slice(-decimals).replace(/0+$/, '')
  return padded.slice(0, -decimals) + (tail ? '.' + tail : '')
}
function hexQuantity(value) {
  return '0x' + unsigned(typeof value === 'bigint' ? value.toString() : value).toString(16)
}
function fromHex(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw Error('Invalid RPC quantity')
  return BigInt(value)
}
module.exports = { precision, unsigned, parseAmount, formatAmount, hexQuantity, fromHex }
