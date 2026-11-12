'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { createTransport } = require('./publicnode.cjs')
const { NETWORKS } = require('./networks.cjs')
const { derive } = require('./keys.cjs')
const { unsigned, formatAmount } = require('./amounts.cjs')
const { assessSpam, assetVisible, displayText } = require('./spam.cjs')
const MAX_ASSETS = 500
function createAccountPlugin(network, { dataDirectory, transport, adapter: suppliedAdapter, iconCache, now = Date.now } = {}) {
  const config = NETWORKS[network]
  if (!config || !dataDirectory) throw Error('Invalid account module configuration')
  // Polygon contract calls exceeded 18 s in live checks. Head + parallel
  // contract reads stay within the 60 s operation budget (18 + 30 s).
  // Logo downloads run independently, after the verified token is saved.
  transport ||= createTransport(network, { timeoutMs: 18000, contractTimeoutMs: 30000, attempts: 2 })
  iconCache ||= require('./icons.cjs').createIconCache(network, dataDirectory)
  const adapter = suppliedAdapter || (config.chainId ? require('../evm/adapter.cjs').evmAdapter(network, config, transport)
    : network === 'solana' ? require('../sol/adapter.cjs').solAdapter(config, transport) : require('../trx/adapter.cjs').tronAdapter(config, transport))
  const states = new Map(), plans = new Map(), pending = new Map(), pendingIcons = new Map()
  let closed = false
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  function ownerAddress(value) { if (!adapter.validate(value)) throw Error('Invalid wallet address'); return adapter.normalize(value) }
  function stateFor(owner) {
    if (states.has(owner)) return states.get(owner)
    const filename = path.join(dataDirectory, crypto.createHash('sha256').update(network + ':' + owner).digest('hex') + '.json')
    let state = { schemaVersion: 1, owner, tokens: {}, candidates: [], discovery: { complete: false, reason: 'not-checked' }, receipts: [] }
    if (fs.existsSync(filename)) {
      const stat = fs.lstatSync(filename)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error('Invalid account module state')
      const saved = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (saved.schemaVersion !== 1 || saved.owner !== owner || !saved.tokens || Array.isArray(saved.tokens) || Object.keys(saved.tokens).length > MAX_ASSETS) throw Error('Invalid saved token state')
      state = { ...state, ...saved }
      // Before import flags existed, only discovery populated candidates;
      // explicitly added contracts lived solely in tokens. Recover those
      // imports even if an interrupted old download left no icon metadata.
      if (Array.isArray(saved.candidates)) {
        const discovered = new Set(saved.candidates)
        for (const token of Object.values(state.tokens)) {
          if (token.imported === undefined && !discovered.has(token.id)) token.imported = true
        }
      }
    }
    state.filename = filename; states.set(owner, state); return state
  }
  function save(state) {
    if (closed) return
    const { filename, ...publicState } = state
    const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    try { fs.writeFileSync(temporary, JSON.stringify(publicState), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename) }
    finally { fs.rmSync(temporary, { force: true }) }
  }
  function decorate(token, previous = {}) {
    const assessment = assessSpam(token)
    return { ...token, name: displayText(token.name, token.id), symbol: displayText(token.symbol, 'TOKEN', 24),
      assessment, icon: previous.icon, imported: previous.imported === true, iconRetryAt: previous.iconRetryAt, iconFailures: previous.iconFailures,
      override: previous.override, visible: assetVisible(assessment, previous.override),
      amount: formatAmount(token.atomic, token.decimals), verifiedAt: now(), status: token.complete ? 'verified' : 'partial' }
  }
  function view(state) {
    return { network, owner: state.owner, provider: 'PublicNode', discovery: state.discovery, updating: pending.has(state.owner),
      tokens: Object.values(state.tokens).map(token => ({ id: token.id, name: token.name, symbol: token.symbol, decimals: token.decimals,
        atomic: token.atomic, amount: token.amount, complete: token.complete, standard: token.standard, status: token.status,
        verifiedAt: token.verifiedAt, icon: iconCache.peek?.(token.id) || (pendingIcons.has(state.owner + ':' + token.id) ? { status: 'loading' } : token.icon),
        assessment: token.assessment, override: token.override, visible: assetVisible(token.assessment, token.override) })),
      receipts: state.receipts || [] }
  }
  async function refresh(state) {
    try {
      const block = await adapter.head()
      let result
      try { result = await adapter.discover(state.owner, state, block) }
      catch { result = { candidates: [], complete: false, reason: 'discovery-unavailable' } }
      const candidates = new Set([...(state.candidates || []), ...result.candidates])
      if (candidates.size > MAX_ASSETS) result = { ...result, complete: false, reason: 'local-token-limit' }
      state.candidates = [...candidates].slice(0, MAX_ASSETS)
      if (result.cursor !== undefined) state.cursor = result.cursor
      const all = [...new Set([...Object.keys(state.tokens), ...state.candidates])].slice(0, MAX_ASSETS)
      // Refresh a bounded rotating batch. A busy or unavailable token cannot
      // stall the native coin, other networks or all later tokens indefinitely.
      const offset = (state.tokenOffset || 0) % Math.max(all.length, 1)
      const selected = Array.from({ length: Math.min(4, all.length) }, (_, i) => all[(offset + i) % all.length])
      await Promise.all(selected.map(async id => {
        try {
          const value = await adapter.token(id, state.owner, block, state.tokens[id])
          if (state.tokens[value.id] || Object.keys(state.tokens).length < MAX_ASSETS) state.tokens[value.id] = decorate(value, state.tokens[value.id])
          else result = { ...result, complete: false, reason: 'local-token-limit' }
        } catch {
          if (state.tokens[id]) state.tokens[id] = { ...state.tokens[id], status: 'unavailable' }
        }
      }))
      state.tokenOffset = all.length ? (offset + selected.length) % all.length : 0
      state.discovery = { complete: result.complete && all.every(id => state.tokens[id]?.status === 'verified'), reason: result.reason,
        checkedAt: now(), height: block.height, cursor: state.cursor, candidates: all.length }
      if (adapter.receipt) for (const receipt of (state.receipts || []).filter(r => ['unknown', 'submitted'].includes(r.status)).slice(0, 4)) {
        try { receipt.status = await adapter.receipt(receipt.txid); receipt.checkedAt = now() }
        catch { /* Preserve unresolved receipts; an unavailable check is not failure. */ }
      }
    } catch {
      state.discovery = { ...state.discovery, complete: false, reason: 'network-unavailable', checkedAt: now() }
      for (const token of Object.values(state.tokens)) token.status = 'unavailable'
    }
    finally { save(state) }
  }
  function startRefresh(state, force = false) {
    if (closed || pending.has(state.owner) || (!force && now() - (state.discovery.checkedAt || 0) < 30000)) return
    const operation = refresh(state).catch(() => {}).finally(() => pending.delete(state.owner))
    pending.set(state.owner, operation)
  }
  function loadIcon(state, id) {
    const key = state.owner + ':' + id
    if (pendingIcons.has(key)) return pendingIcons.get(key)
    const operation = (async () => {
      let icon
      try { icon = await iconCache.load(id) } catch { icon = { status: 'unavailable' } }
      if (closed || !state.tokens[id]) return
      // Resolve after await: balance refresh may have replaced this record.
      const token = state.tokens[id]
      token.icon = icon
      token.iconFailures = icon?.status === 'cached' ? 0 : Math.min(8, (token.iconFailures || 0) + 1)
      token.iconRetryAt = icon?.status === 'cached' ? 0 : now() + Math.min(3600000, 30000 * 2 ** (token.iconFailures - 1))
      save(state)
    })().finally(() => pendingIcons.delete(key))
    pendingIcons.set(key, operation)
    return operation
  }
  function recoverImportedIcons(state) {
    if (closed || pendingIcons.size) return
    // Legacy releases recorded icon metadata only on explicit import. That
    // also lets existing imported tokens recover without re-entering a contract.
    // Never download logos for unsolicited tokens found during discovery.
    const token = Object.values(state.tokens).find(token => (token.imported || token.icon)
      && (iconCache.peek ? !iconCache.peek(token.id) : token.icon?.status !== 'cached')
      && now() >= (token.iconRetryAt || 0))
    if (token) void loadIcon(state, token.id).catch(() => {})
  }
  async function snapshot(params) {
    const addresses = [...new Set((params.addresses || []).map(ownerAddress))]
    if (addresses.length > 10) throw Error('Too many account addresses')
    const block = await adapter.head(), balances = {}, errors = {}
    if (params.includeBalances !== false) {
      await Promise.all(addresses.map(async owner => {
        try {
          const value = unsigned(await adapter.balance(owner, block)).toString()
          balances[owner] = { balance: value, balance_spendable: value, received: value, immature: '0' }
        } catch {
          // A balance endpoint outage does not invalidate the independently
          // verified network head. Return an explicit missing balance, never 0.
          errors['balance:' + owner] = 'Current balance could not be verified'
        }
      }))
      for (const owner of addresses) {
        try { startRefresh(stateFor(owner)) }
        catch { errors.assets = 'Saved token state is unavailable' }
      }
    }
    return { coin: network, network: { ok: true, coin: network, chain: network + '-mainnet', blocks: block.height, headers: block.height, initialBlockDownload: false, walletScanPercent: 100 },
      walletBalance: null, balances, histories: {}, errors: { ...errors, ...(params.includeHistory ? { history: 'PublicNode does not provide complete address history' } : {}) } }
  }
  async function request(method, params = {}) {
    if (closed) throw Error('Module session closed')
    if (method === 'derive') return derive(network, params.mnemonic)
    if (method === 'validate') return adapter.validate(params.address)
    if (method === 'snapshot') return snapshot(params)
    if (method === 'assets') {
      const state = stateFor(ownerAddress(params.owner)); startRefresh(state, params.force === true); recoverImportedIcons(state); return view(state)
    }
    if (method === 'importAsset') {
      const owner = ownerAddress(params.owner), state = stateFor(owner)
      try {
        const id = adapter.normalize(params.asset)
        if (!state.tokens[id] && Object.keys(state.tokens).length >= MAX_ASSETS) return { error: 'Token limit reached' }
        const token = await adapter.token(id, owner, await adapter.head(), state.tokens[id])
        if (!state.tokens[token.id] && Object.keys(state.tokens).length >= MAX_ASSETS) return { error: 'Token limit reached' }
        state.tokens[token.id] = decorate(token, state.tokens[token.id])
        state.tokens[token.id].imported = true
        // Persist the user's opt-in before downloading. A failed request or
        // interrupted application must not leave the token without a retry.
        save(state)
        void loadIcon(state, token.id).catch(() => {})
        save(state); return view(state)
      } catch (cause) {
        // Keep public diagnostics useful without returning provider bodies,
        // request parameters or arbitrary exception text.
        const allowed = ['NETWORK', 'INVALID_DATA', 'SIZE', 'AUTH_REQUIRED', 'RPC', 'BAD_DATA', 'CALL_EXCEPTION', 'INVALID_ARGUMENT', 'EACCES', 'ENOSPC', 'ENOENT']
        const code = allowed.includes(cause?.code) || (Number.isInteger(cause?.code) && (cause.code >= 400 && cause.code <= 599 || cause.code >= -32768 && cause.code <= -32000)) ? cause.code : 'UNAVAILABLE'
        return { error: 'Could not verify this token through PublicNode. Check the network and contract or mint address.', code }
      }
    }
    if (method === 'setAssetVisibility') {
      const state = stateFor(ownerAddress(params.owner)), id = adapter.normalize(params.asset)
      if (!state.tokens[id] || !['show', 'hide', 'auto'].includes(params.visibility)) throw Error('Invalid token visibility request')
      state.tokens[id].override = params.visibility === 'auto' ? undefined : params.visibility; save(state); return view(state)
    }
    if (method === 'prepareTransfer') {
      // No mnemonic is needed for preparation. The transaction and fee are
      // retained in this worker; renderer input cannot replace the reviewed tx.
      const owner = ownerAddress(params.owner), to = ownerAddress(params.to), state = stateFor(owner)
      const asset = params.asset ? state.tokens[adapter.normalize(params.asset)] : null
      if (params.asset && (!asset || !assetVisible(asset.assessment, asset.override))) return { error: 'Enable and verify this token before sending it' }
      try {
        const block = await adapter.head()
        const fresh = asset ? await adapter.token(asset.id, owner, block, asset) : null
        if (fresh && !assetVisible(assessSpam(fresh), asset.override)) return { error: 'Enable this token explicitly before sending it' }
        const prepared = await adapter.prepare({ owner, to, amount: params.amount, asset: fresh, assetVerified: true, max: params.max === true }, block)
        const planId = crypto.randomBytes(24).toString('hex'), expiresAt = now() + 45000
        for (const [id, plan] of plans) if (plan.expiresAt < now()) plans.delete(id)
        if (plans.size >= 10) plans.delete(plans.keys().next().value)
        const summary = { planId, expiresAt, network, owner, to, asset: fresh?.id || null, symbol: fresh ? displayText(fresh.symbol, 'TOKEN', 24) : config.ticker,
          amount: formatAmount(prepared.atomic, fresh?.decimals ?? config.decimals), fee: formatAmount(prepared.feeAtomic, config.decimals),
          rent: formatAmount(prepared.rentAtomic || '0', config.decimals), nativeRequired: formatAmount(prepared.nativeRequired, config.decimals), feeSymbol: config.ticker }
        plans.set(planId, { ...prepared, ...summary }); return summary
      } catch (error) {
        const known = /^(?:Insufficient |Amount must |Amount exceeds |Enter a valid |No unlocked |Sending this Token-2022|Token transfer exceeds |Tron SDK cannot|Choose a different|Gas estimate changed|Destination token account)/.test(error.message)
        return { error: known ? error.message : 'PublicNode could not prepare this transfer. No transaction was signed.' }
      }
    }
    if (method === 'send') {
      const plan = plans.get(params.planId); plans.delete(params.planId)
      if (!plan || plan.expiresAt <= now() || params.confirmed !== true) return { error: 'Transfer preview expired. Prepare and review it again.' }
      for (const [id, other] of plans) if (other.owner === plan.owner) plans.delete(id)
      let signed
      try { await adapter.head(); signed = await adapter.sign(plan, params.mnemonic) }
      catch { return { error: 'Transfer could not be signed. Nothing was submitted.' } }
      const state = stateFor(plan.owner)
      const receipt = { txid: signed.txid, status: 'unknown', at: now(), to: plan.to, asset: plan.asset, amount: plan.amount }
      const previousReceipts = state.receipts || []
      state.receipts = [receipt, ...previousReceipts].slice(0, 100)
      // Preserve the local transaction ID BEFORE a possibly ambiguous submission.
      try { save(state) }
      catch {
        state.receipts = previousReceipts
        return { error: 'Could not save the transfer checkpoint. Nothing was submitted.' }
      }
      try {
        const result = await transport.broadcast(signed.serialized)
        if (network === 'tron' ? result?.result === true && result.txid === signed.txid : result === signed.txid) receipt.status = 'submitted'
      } catch { /* Unknown submission is never automatically retried. */ }
      // The durable pre-submission checkpoint already contains this ID. A
      // second disk failure must not turn a submitted transfer into a failed
      // operation with no transaction ID visible to the caller.
      try { save(state) } catch { /* Restore its unknown status from the checkpoint on restart. */ }
      return { ...receipt, fee: plan.fee }
    }
    if (method === 'nodeRequest') {
      const route = String(params.path).split('?')[0]
      if (route === '/address/validate') return { valid: adapter.validate(params.body?.address) }
      if (route === '/network') return (await snapshot({ includeBalances: false })).network
      throw Error('PublicNode does not provide this indexed wallet route')
    }
    throw Error('Unsupported account module operation')
  }
  return { request, async close() { closed = true; plans.clear() }, waitForIdle: () => Promise.all([...pending.values()]), waitForIcons: () => Promise.all([...pendingIcons.values()]) }
}
module.exports = { createAccountPlugin }
