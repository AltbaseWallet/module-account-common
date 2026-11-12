'use strict'
const truth = value => value === true || value === 1 || value === '1' || value === 'true'
// Control characters are intentionally matched to detect deceptive metadata.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
const LINK = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|app|site|live|click|top|win|claim|finance)\b)/iu
const LURE = /\b(?:claim|airdrop|reward|giveaway|visit|redeem|free\s+money)\b/iu
function assessSpam(metadata = {}, policy = {}) {
  const reasons = []
  if (truth(policy.blocked)) reasons.push('blocked-contract')
  if (truth(policy.spam)) reasons.push('local-spam-rule')
  if (truth(policy.impersonation)) reasons.push('token-impersonation')
  if (truth(policy.unsolicitedBulkTransfer)) reasons.push('unsolicited-bulk-transfer')
  const text = [metadata.name, metadata.symbol].filter(x => typeof x === 'string').join(' ').normalize('NFKC')
  if (CONTROL.test(text)) reasons.push('deceptive-control-characters')
  if (LINK.test(text)) reasons.push(LURE.test(text) ? 'claim-link' : 'link-in-token-name')
  const verified = truth(policy.verified)
  return { classification: reasons.length ? 'spam' : verified ? 'verified' : 'unverified', reasons }
}
function assetVisible(assessment, override) {
  if (override === 'show') return true
  if (override === 'hide') return false
  return assessment?.classification !== 'spam'
}
function displayText(value, fallback, maximum = 96) {
  if (typeof value !== 'string') return fallback
  // eslint-disable-next-line no-control-regex -- remove the same deceptive controls from display
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim()
  return text ? [...text].slice(0, maximum).join('') : fallback
}
module.exports = { assessSpam, assetVisible, displayText }
