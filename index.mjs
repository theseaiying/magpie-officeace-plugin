// OpenCode provider plugin for OfficeAce, Huawei Cloud's coding plan (the
// AgentArts model gateway behind the OfficeAce / DevEco Studio desktop
// agent). An account signs in in the browser (Huawei Cloud's OAuth page,
// polled for the authorization code as the desktop app does) or brings a
// gateway key it already has; no OfficeAce desktop app is needed. Chats are
// chat completions at the account's own gateway, OpenAI's shape, authorized
// with a Basic key that does not expire.
//
// The control plane (which models and key the account may use, its credits)
// runs on temporary AK/SK credentials that end in a day; they are renewed
// from the refresh token in a DPoP-signed request well before they end, and
// what a renewal gave is saved back to the account. The refresh token
// rotates on every renewal: the one spent is dead, so a renewal under way
// answers the requests that come while it runs, and a renewal just done
// answers for the old token for a minute.

import { createHmac, createHash, randomBytes, randomUUID, webcrypto } from "node:crypto"

const PROVIDER = "officeace"

// the endpoints OfficeAce's own client uses, as officeace2api reads them out
// of the desktop app: the AgentArts control plane, Huawei Cloud's auth pages,
// the STS token endpoint the refresh token is spent at
const CLOUD_BASE = "https://agentarts.cn-southwest-2.myhuaweicloud.com"
const AUTH_BASE = "https://auth.huaweicloud.com"
const TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"
const CLIENT_ID = "pdp5_for_agentarts"
const REDIRECT_URI = `${CLOUD_BASE}/v1/claw/auth/callback`
const REGION = "cn-southwest-2"
const SCOPE_SERVICE = "apic" // APIG's service name in the V11 credential scope

const POLL_MS = 2500
const SIGN_IN_MS = 5 * 60 * 1000
const EARLY_MS = 10 * 60 * 1000 // credentials this close to their end are renewed before a request
const LEAD_MS = 60 * 60 * 1000 // and this close, magpie renews them ahead of time (auth.refresh)
const KEEP_RENEWED_MS = 60 * 1000 // how long a renewal's result answers for the old refresh token
const USED_TOKEN_CODES = ["STS5.1806", "STS5.1807"] // a refresh token already spent

// the default gateway, where the subscription API answers; a sign-in always
// carries its own, and chats go to <baseUrl>/chat/completions, the baseUrl
// the account was given (it ends in /v2)
const DEFAULT_GATEWAY = "https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com"
const UA = "OfficeAce/1.0"

// [id, name, context, efforts] — the models the gateway is known to serve,
// as officeace2api's registry reads them; the account's own list comes from
// the gateway's /models when it answers. glm-5.3 takes no thinking param
// (officeace2api strips it), so it gets no reasoning levels here either.
const MODELS = [
  ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", 1000000, ["high"]],
  ["deepseek-v4-flash", "DeepSeek-V4-Flash", 1000000],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro", 1000000, ["high"]],
  ["deepseek-v4-flash-0731", "DeepSeek-V4-Flash-0731", 1000000],
  ["deepseek-v3.2", "DeepSeek-V3.2", 128000, ["high"]],
  ["deepseek-r1-250528", "DeepSeek-R1-250528", 128000, ["high"]],
  ["glm-5.3", "GLM-5.3", 198000],
  ["glm-5.2", "GLM-5.2", 198000, ["high"]],
  ["glm-5.1", "GLM-5.1", 198000, ["high"]],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["qwen3-32b", "Qwen3-32B", 128000],
  ["qwen3-30b-a3b", "Qwen3-30B-A3B", 128000],
  ["openpangu-2.0-pro", "openPangu-2.0-Pro", 128000],
  ["openpangu-2.0-flash", "openPangu-2.0-Flash", 128000],
]

const NPM = "@ai-sdk/openai-compatible"
const b64u = (buf) => Buffer.from(buf).toString("base64url")
const hex = () => randomBytes(16).toString("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- the account's gateway ----------------------------------------------

// baseUrlOf is where an account's chats and model list go: the base its
// sign-in named (it ends in /v2), else the default gateway's.
function baseUrlOf(a) {
  const base = String(a?.baseUrl || "").replace(/\/+$/, "")
  return base || DEFAULT_GATEWAY + "/v2"
}

// hostOf is the gateway host the subscription API answers at: the base
// without its /v2 (or whatever version) tail.
function hostOf(a) {
  return baseUrlOf(a).replace(/\/v\d+\/?$/, "")
}

// basicOf is the Authorization an account signs chats with: the key it was
// imported with, else the pair the permission check gave, Basic(key:secret).
function basicOf(a) {
  if (a?.authorization) return a.authorization
  if (a?.appKey && a?.appSecret) return "Basic " + Buffer.from(`${a.appKey}:${a.appSecret}`).toString("base64")
  return ""
}

// ---- Huawei Cloud's signatures ---------------------------------------------
// (as officeace2api reads them out of the desktop app's signer: the control
// plane signs SDK-HMAC-SHA256, the subscription API V11-HMAC-SHA256, whose
// key is derived through the region scope)

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex")
const hmacHex = (key, data) => createHmac("sha256", key).update(data).digest("hex")
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

function sdkDate() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
}

function canonicalUri(url) {
  let p = url.pathname.split("/").map((seg) => rfc3986(decodeURIComponent(seg))).join("/")
  if (!p.endsWith("/")) p += "/"
  return p
}

function canonicalQuery(url) {
  const pairs = []
  url.searchParams.forEach((v, k) => pairs.push([k, v]))
  pairs.sort(([a, b], [c, d]) => (a === c ? b.localeCompare(d) : a.localeCompare(c)))
  return pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&")
}

function signedHeaders(headers) {
  const norm = {}
  for (const [k, v] of Object.entries(headers)) norm[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ")
  const names = Object.keys(norm).sort()
  return { norm, names }
}

function canonicalRequest(method, url, norm, names, payloadHash) {
  const head = names.map((n) => `${n}:${norm[n]}`).join("\n") + "\n"
  return [method.toUpperCase(), canonicalUri(url), canonicalQuery(url), head, names.join(";"), payloadHash].join("\n")
}

function commonHeaders(out, url, credential, contentType, sdkDateOverride) {
  out["X-Sdk-Date"] = sdkDateOverride || sdkDate()
  if (credential.securityToken) out["X-Security-Token"] = credential.securityToken
  out.Host = new URL(url).host
  if (contentType) out["Content-Type"] = contentType
  if (credential.projectId) out["X-Project-ID"] = credential.projectId
  return out
}

// signV4 is the control plane's SDK-HMAC-SHA256: the SK is the key itself.
function signV4({ method, url, credential, bodyText = "", headers = {}, contentType, sdkDateOverride }) {
  const out = commonHeaders({ ...headers }, url, credential, contentType, sdkDateOverride)
  const { norm, names } = signedHeaders(out)
  const cr = canonicalRequest(method, new URL(url), norm, names, sha256Hex(bodyText))
  const sts = ["SDK-HMAC-SHA256", norm["x-sdk-date"], sha256Hex(cr)].join("\n")
  out.Authorization = `SDK-HMAC-SHA256 Access=${credential.accessKey}, SignedHeaders=${names.join(";")}, Signature=${hmacHex(credential.secretKey, sts)}`
  return out
}

// signV11 is the subscription API's V11-HMAC-SHA256: the signing key is
// HMAC(HMAC(AK, SK), scope + 0x01)[0..32], as hex — Huawei's own derivation.
function signV11({ method, url, credential, region = REGION, bodyText = "", headers = {}, contentType, sdkDateOverride }) {
  const out = commonHeaders({ ...headers }, url, credential, contentType, sdkDateOverride)
  const { norm, names } = signedHeaders(out)
  const date = norm["x-sdk-date"]
  const scope = `${date.slice(0, 8)}/${region}/${SCOPE_SERVICE}`
  const cr = canonicalRequest(method, new URL(url), norm, names, sha256Hex(bodyText))
  const sts = ["V11-HMAC-SHA256", date, scope, sha256Hex(cr)].join("\n")
  const step1 = createHmac("sha256", credential.accessKey).update(credential.secretKey).digest()
  const seed = Buffer.concat([Buffer.from(scope, "utf8"), Buffer.from([1])])
  const signingKey = createHmac("sha256", step1).update(seed).digest().subarray(0, 32).toString("hex")
  out.Authorization = `V11-HMAC-SHA256 Credential=${credential.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmacHex(signingKey, sts)}`
  return out
}

// ---- DPoP -------------------------------------------------------------------

// dpopProof signs a DPoP proof JWT with an account's P-256 private JWK:
// header {typ dpop+jwt, alg ES256, jwk public}, payload {htm, htu, iat, jti};
// the signature is the raw R||S the WebCrypto ES256 gives, base64url.
async function dpopProof(privateJwk, publicJwk, htm, htu, nowMs = Date.now()) {
  if (!privateJwk?.d || privateJwk.kty !== "EC") throw new Error("no DPoP private key on this account")
  const key = await webcrypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: privateJwk.crv || "P-256", x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const pub = publicJwk || privateJwk
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty: pub.kty || "EC", x: pub.x, y: pub.y, crv: pub.crv || "P-256" } }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: hex() }
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signingInput))
  return `${signingInput}.${b64u(new Uint8Array(sig))}`
}

// dpopKeyPair makes the P-256 pair a browser sign-in keeps for its renewals.
async function dpopKeyPair() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const priv = await webcrypto.subtle.exportKey("jwk", pair.privateKey)
  const pub = await webcrypto.subtle.exportKey("jwk", pair.publicKey)
  return {
    privateJwk: { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d },
    publicJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
  }
}

// ---- the STS token endpoint --------------------------------------------------

async function tokenCall(dpop, body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: dpop },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { res, json, text }
}

// renewing is each renewal under way, by the refresh token it spends;
// renewed is what each gave, kept a minute so one that read the old token
// after it was spent takes that rather than spending it again.
const renewing = new Map()
const renewed = new Map()

// renew spends a's refresh token, once. save keeps the result — the token
// rotates: the one spent is dead the moment the cloud answered.
function renew(a, save) {
  const key = a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve({ ...a, ...pickTokenFields(done.next) })
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const proof = await dpopProof(a.dpopPrivateJwk, a.dpopPublicJwk, "POST", TOKEN_URL)
      const { res, json, text } = await tokenCall(proof, {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: a.refresh,
      })
      const code = String(json?.error_code || json?.error || (res.ok ? "" : res.status))
      if (!res.ok || !json?.credentials) {
        const msg = String(json?.error_msg || json?.error_description || text.slice(0, 200) || res.statusText)
        const why = `${code || "HTTP " + res.status}${msg ? " · " + msg : ""}`
        if (USED_TOKEN_CODES.some((c) => code.includes(c)))
          throw Object.assign(new Error(`OfficeAce: the refresh token has been used (${why}); sign in again`), { bare: true })
        throw Object.assign(new Error(`OfficeAce token refresh: ${why}`), { bare: true })
      }
      const next = mergeToken(a, json)
      renewed.set(key, { next, at: Date.now() })
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then((next) => ({ ...a, ...pickTokenFields(next) }))
}

// mergeToken folds a token endpoint answer (a sign-in's or a renewal's) into
// the account: the temporary credentials, the rotated refresh token, its end.
function mergeToken(a, json) {
  const c = json.credentials || {}
  const claims = json.id_token ? claimsOf(json.id_token) : {}
  return {
    ...a,
    access: String(c.access_key_id || ""),
    secret: String(c.secret_access_key || ""),
    securityToken: String(c.security_token || ""),
    projectId: String(c.project_id || a.projectId || ""),
    expires: Date.parse(c.expiration || "") || a.expires || 0,
    refresh: String(json.refresh_token || a.refresh || ""),
    refreshExpiresAt: (json.refresh_expires_at ? Date.parse(json.refresh_expires_at) : 0) || a.refreshExpiresAt || 0,
    uid: claims.sub || a.uid || "",
    userName: claims.userName || a.userName || "",
  }
}

const TOKEN_FIELDS = ["access", "secret", "securityToken", "projectId", "expires", "refresh", "refreshExpiresAt", "uid", "userName"]

function pickTokenFields(next) {
  const out = {}
  for (const k of TOKEN_FIELDS) if (k in next) out[k] = next[k]
  return out
}

// claimsOf reads an id_token's payload; no signature check — not a boundary.
function claimsOf(idToken) {
  try {
    const parts = String(idToken || "").split(".")
    if (parts.length < 2) return {}
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return {
      sub: typeof p.sub === "string" ? p.sub : "",
      userName: typeof p.preferred_username === "string" ? p.preferred_username : typeof p.name === "string" ? p.name : "",
    }
  } catch {
    return {}
  }
}

function refreshable(a) {
  return !!a.refresh && !!a.dpopPrivateJwk && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt)
}

function stale(a) {
  return !!a.expires && Date.now() >= a.expires - EARLY_MS
}

// fresh is the account with credentials that aren't about to end: renewed
// (and saved) when they are. A failed renewal leaves the credentials there
// are — chats go on the Basic key, which doesn't end.
async function fresh(a, save) {
  if (!stale(a)) return a
  if (!refreshable(a)) {
    if (a.access && a.secret) return a
    throw new Error("this OfficeAce account's credentials have ended; sign in again")
  }
  try {
    return await renew(a, save)
  } catch (e) {
    if (a.access && a.secret) return a
    throw e
  }
}

// refreshed is what magpie's auth.refresh gives: the fields a renewal
// changed, nothing when there's nothing to renew. A refresh token past its
// end is said as an expired sign-in — nothing else can bring it back.
async function refreshed(auth) {
  if (auth?.type !== "oauth" || !auth.refresh || !auth.dpopPrivateJwk) return undefined
  if (auth.refreshExpiresAt && Date.now() >= auth.refreshExpiresAt)
    throw Object.assign(new Error("this OfficeAce account's sign-in has ended; sign in again"), { signIn: "expired" })
  let next
  try {
    next = await renew(auth)
  } catch (e) {
    throw e?.bare ? e : new Error(`OfficeAce token refresh: ${e?.message ?? e}`)
  }
  const out = {}
  for (const k of TOKEN_FIELDS) if (k in next && next[k] !== auth[k]) out[k] = next[k]
  return Object.keys(out).length ? out : undefined
}

// ---- the control plane --------------------------------------------------------

// credentialOf is the account's temporary credentials, as the signer takes them.
const credentialOf = (a) => ({
  accessKey: a.access,
  secretKey: a.secret,
  securityToken: a.securityToken,
  projectId: a.projectId,
})

// meter asks the control plane, SDK-signed with the temporary credentials.
async function meter(a, url, { headers = {}, contentType } = {}) {
  const signed = signV4({ method: "GET", url, credential: credentialOf(a), headers, contentType })
  const res = await fetch(url, { method: "GET", headers: signed, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, ok: res.ok, json, text }
}

// permission asks which gateway and Basic key the account may use, as the
// desktop app does after every sign-in.
async function permission(a) {
  const { ok, json } = await meter(a, `${CLOUD_BASE}/v1/claw/client-permission-validate`, {
    contentType: "application/json;charset=utf8",
  })
  if (!ok) throw new Error(`OfficeAce's permission check failed: ${json?.error_msg || json?.error_code || "HTTP ?"}`)
  const mi = json?.model_info || json?.subscription?.model_info || json?.modelInfo || null
  const host = String(mi?.model_api_url_base || "").replace(/^https?:\/\//, "").replace(/\/+$/, "")
  return {
    accountId: String(json?.account_id || a.accountId || ""),
    principalId: String(json?.principal_id || a.uid || ""),
    appKey: String(mi?.model_auth_info?.model_app_key || ""),
    appSecret: String(mi?.model_auth_info?.model_app_secret || ""),
    baseUrl: host ? `https://${host}/v2` : "",
  }
}

// controlCall asks the subscription API at the account's gateway host,
// V11-signed, and keeps the status the caller needs to tell a lapsed
// sign-in from a rate limit.
async function controlCall(a, method, path, bodyText) {
  const url = hostOf(a) + path
  const headers = signV11({
    method,
    url,
    credential: credentialOf(a),
    headers: { "x-subscription-type": "v2" },
    ...(bodyText === undefined ? {} : { bodyText, contentType: "application/json" }),
  })
  const res = await fetch(url, {
    method,
    headers,
    ...(bodyText === undefined ? {} : { body: bodyText }),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, ok: res.ok, json, text }
}

// subscriptionOf is the plan and its credits, V11-signed at the account's
// gateway host, as the OfficeAce client's subscription card reads it.
async function subscriptionOf(a) {
  return (await controlCall(a, "GET", "/v1/subscription")).json
}

// claimBonus presses the subscription card's one claim: the day's sign-in
// reward and any one-time newcomer gift, in one idempotent POST that answers
// the updated subscription. Its body is the empty object the client sends.
function claimBonus(a) {
  return controlCall(a, "POST", "/v1/subscription/bonus/claim", "{}")
}

// bonusList is a subscription's bonus entries, keyed by what names one
// across two reads: its activity id, its resource id, else its name.
function bonusList(sub) {
  const items = Array.isArray(sub?.bonus_skus) ? sub.bonus_skus : []
  const out = []
  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const key = String(item.activity_id ?? item.cbc_resource_id ?? item.activity_name ?? "").trim()
    if (!key) continue
    out.push({ key, total: Number(item.points) || 0, used: Number(item.current_value) || 0 })
  }
  return out
}

// gainedBetween counts what a claim added: each bonus's remaining amount
// grew by this much. One seen for the first time counts its remaining, not
// its whole grant, which may have come earlier.
function gainedBetween(before, after) {
  const previous = new Map()
  for (const b of bonusList(before)) previous.set(b.key, Math.max(0, b.total - b.used))
  let gained = 0
  for (const b of bonusList(after)) {
    const left = Math.max(0, b.total - b.used)
    gained += Math.max(0, left - (previous.get(b.key) ?? 0))
  }
  return gained
}

// vendorError is the refusal the subscription or claim answer carries.
function vendorError(json) {
  if (!json || typeof json !== "object") return ""
  if (json.error_code) {
    const msg = json.error_msg || json.message || ""
    return `${json.error_code}${msg ? `: ${msg}` : ""}`
  }
  const code = Number.parseInt(json.code, 10)
  if (Number.isFinite(code) && code !== 0) {
    const msg = json.message || json.error_msg || ""
    return `${code}${msg ? `: ${msg}` : ""}`
  }
  return ""
}

// redacted keeps a vendor message from echoing a credential into the
// check-in result Magpie keeps.
function redacted(a, text) {
  let out = String(text ?? "")
  for (const secret of [a?.access, a?.secret, a?.securityToken, a?.appSecret, a?.refresh]) {
    if (typeof secret === "string" && secret) out = out.split(secret).join("[redacted]")
  }
  return out.length > 200 ? out.slice(0, 197) + "..." : out
}

// baselineOf is a subscription answer usable as a balance: its bonus list,
// no vendor error, and an object rather than an error page. Anything else
// would make every bonus look new.
function baselineOf(res) {
  const json = res?.json
  return res?.ok && json && typeof json === "object" && !Array.isArray(json)
    && !vendorError(json) && Array.isArray(json.bonus_skus) ? json : null
}

const TIER_NAMES = { trial: "试用版", starter: "入门版", standard: "标准版", advanced: "高级版", premium: "尊享版", ultimate: "旗舰版" }

const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// usageOf turns a subscription answer into magpie's usage card: the credits
// of the plan's skus and of the bonuses still alive, total minus used, the
// expired entries not counted — the arithmetic OfficeAce's own picker does.
// An unlimited quota (-1) says no share, and is left out of the window.
function usageOf(sub, now = Date.now()) {
  const skus = Array.isArray(sub?.skus) ? sub.skus : []
  const bonus = Array.isArray(sub?.bonus_skus) ? sub.bonus_skus : []
  let total = 0, used = 0
  const dying = []
  for (const s of skus) {
    for (const q of Array.isArray(s?.quotas) ? s.quotas : []) {
      if (q?.sku_attr_code !== "officeace_points") continue
      const exp = Date.parse(q?.expired_time || "") || 0
      if (exp && exp <= now) continue
      const grant = Number(q.sku_value) || 0
      if (grant < 0) continue
      total += grant
      used += Number(q.current_value) || 0
      dying.push({ left: grant - (Number(q.current_value) || 0), exp })
    }
  }
  for (const b of bonus) {
    const exp = Date.parse(b?.expired_time || "") || 0
    if (exp && exp <= now) continue
    const grant = Number(b.points) || 0
    if (grant < 0) continue
    total += grant
    used += Number(b.current_value) || 0
    dying.push({ left: grant - (Number(b.current_value) || 0), exp })
  }
  const windows = []
  if (total > 0) {
    windows.push({
      name: "Credits",
      used: (100 * used) / total,
      display: `${compact(used)} / ${compact(total)}`,
      amount: used,
      limit: total,
      unit: "credits",
    })
    // the soonest moment credits left are lost, and how many — magpie's
    // smart routing spends the account whose credits expire first. A quota
    // that names no end ends when the plan does, so it isn't counted.
    let at = 0, amount = 0
    for (const d of dying) {
      if (!(d.left > 0) || d.exp <= now) continue
      if (!at || d.exp < at) { at = d.exp; amount = d.left }
      else if (d.exp === at) amount += d.left
    }
    if (at) Object.assign(windows[0], { runsOutAt: new Date(at).toISOString(), runsOut: amount })
  }
  const main = skus[0] || null
  const tier = String(main?.sku_code || "").split(".").pop() || ""
  const until = Date.parse(main?.expired_time || "") || 0
  return {
    plan: main?.sku_name || TIER_NAMES[tier] || (total > 0 ? "OfficeAce" : ""),
    windows,
    ...(until ? { until: new Date(until).toISOString() } : {}),
  }
}

// ---- models -----------------------------------------------------------------

const variants = (efforts) => Object.fromEntries((efforts ?? []).map((e) => [e, { reasoningEffort: e }]))

function staticModels() {
  return Object.fromEntries(
    MODELS.map(([id, name, context, efforts]) => [
      id,
      {
        name,
        limit: { context, output: 0 },
        tool_call: true,
        ...(efforts ? { reasoning: true, variants: variants(efforts) } : {}),
      },
    ]),
  )
}

function modelOf(provider, m) {
  const known = staticModels()[m.id]
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name && m.name !== m.id ? m.name : known?.name || m.id,
    api: { id: m.id, url: baseUrlOf({ baseUrl: m.baseUrl }), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? known?.limit?.context ?? 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: !!known?.reasoning,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: known?.variants ?? {},
  }
}

// liveModels asks the account's own gateway for the models it serves.
async function liveModels(a) {
  const url = baseUrlOf(a) + "/models"
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: basicOf(a), "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`the gateway's model list: HTTP ${res.status}`)
  const doc = await res.json().catch(() => ({}))
  const list = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : []
  return list.map((m) => (typeof m === "string" ? { id: m } : m)).filter((m) => m?.id)
}

// ---- signing in -------------------------------------------------------------

async function fetchState() {
  const res = await fetch(`${CLOUD_BASE}/v1/claw/auth/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let state = ""
  try {
    state = JSON.parse(text).state || ""
  } catch {}
  if (!state) throw new Error(`OfficeAce's sign-in gave no state (HTTP ${res.status})`)
  return state
}

// authorizeUrl is Huawei Cloud's page, as the desktop app opens it.
function authorizeUrl({ state, challenge }) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "SHA-256",
    state,
    scope: "openid",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
  })
  const inner = `${AUTH_BASE}/authui/v1/oauth2/authorize?${params.toString()}`
  const bg = "https://res.hc-cdn.com/AgentArts-Console/26.4.7/hws/assets/login/bg2.png"
  const ad = "https://res.hc-cdn.com/AgentArts-Console/26.4.7/hws/assets/login/ad2.png"
  return `${AUTH_BASE}/authui/login.html?service=${encodeURIComponent(inner)}&background_img_url=${encodeURIComponent(bg)}&portal_img_url=${encodeURIComponent(ad)}`
}

// pollCode asks the cloud for the authorization code until it gives one: a
// 202 means "not yet"; a code that has ended (404) is said plainly.
async function pollCode(state, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error("OfficeAce sign-in timed out")
    const res = await fetch(`${CLOUD_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    })
    if (res.status === 202) {
      await sleep(POLL_MS)
      continue
    }
    if (res.status === 404) throw new Error("OfficeAce's authorization code has ended; start the sign-in again")
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    if (!res.ok) {
      await sleep(POLL_MS)
      continue
    }
    const code = json?.code || json?.authorization_code || ""
    if (!code) throw new Error(String(json?.error_msg || json?.error || "the cloud gave no authorization code"))
    return code
  }
}

// pkce is the code verifier and its S256 challenge.
async function pkce() {
  const verifier = b64u(randomBytes(32))
  const challenge = b64u(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

// exchange turns the authorization code into the account's credentials.
async function exchange(code, { verifier, dpopPrivateJwk, dpopPublicJwk }) {
  const proof = await dpopProof(dpopPrivateJwk, dpopPublicJwk, "POST", TOKEN_URL)
  const { res, json, text } = await tokenCall(proof, {
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  })
  if (!res.ok || !json) {
    const msg = String(json?.error_description || json?.error_msg || json?.error || text.slice(0, 200))
    throw new Error(`OfficeAce's token exchange failed (HTTP ${res.status})${msg ? `: ${msg}` : ""}`)
  }
  const c = json.credentials || json
  if (!c?.access_key_id || !c?.secret_access_key) throw new Error("OfficeAce's token exchange gave no credentials")
  const a = mergeToken({}, {
    credentials: c,
    refresh_token: json.refresh_token,
    id_token: json.id_token,
    refresh_expires_at: json.refresh_expires_at,
  })
  return { ...a, dpopPrivateJwk, dpopPublicJwk }
}

function success(a, name) {
  return {
    type: "success",
    refresh: a.refresh ?? "",
    access: a.access,
    expires: a.expires ?? 0,
    accountId: name || PROVIDER,
    uid: a.uid ?? "",
    // everything the renewals and the control plane need stays on the account
    secret: a.secret ?? "",
    securityToken: a.securityToken ?? "",
    projectId: a.projectId ?? "",
    refreshExpiresAt: a.refreshExpiresAt ?? 0,
    dpopPrivateJwk: a.dpopPrivateJwk ?? null,
    dpopPublicJwk: a.dpopPublicJwk ?? null,
    baseUrl: a.baseUrl ?? "",
    ...(a.userName ? { userName: a.userName } : {}),
    ...(a.appKey ? { appKey: a.appKey } : {}),
    ...(a.appSecret ? { appSecret: a.appSecret } : {}),
  }
}

// ---- the chats ------------------------------------------------------------------

// glm-5.3 and its kin refuse a chat that carries a thinking param
// (officeace2api's MODEL_QUIRKS); the params are stripped for them.
const NO_THINKING = new Set(["glm-5.3", "glm-5.3-test", "glm-5.3-zx", "glm-5-test"])
const STRIP_WHEN_NO_THINKING = ["thinking", "enable_thinking", "reasoning_effort", "stream_options"]

// The gateway counts max_tokens as the budget reasoning AND answer share
// (officeace2api's finding): a reasoning model spends it all thinking and
// answers with nothing. So the budget an agent gave is bumped by an
// allowance for the thinking; an explicit tiny one is passed as it is —
// an agent asking for 1 token means it.
const TINY_MAX_TOKENS = 16
const THINKING_ALLOWANCE = 1024

// fitBody mends a chat body the way officeace2api sends them: the thinking
// params glm-5.3 refuses are gone, the max_tokens budget is bumped, and the
// chat is asked for as a stream — the gateway answers those best, and one
// asked for as one piece is folded back together below. wanted says whether
// the agent asked for a stream; model, the model the chat names.
function fitBody(body) {
  if (typeof body !== "string") return { body, wanted: true, model: "" }
  let b
  try {
    b = JSON.parse(body)
  } catch {
    return { body, wanted: true, model: "" }
  }
  if (b === null || typeof b !== "object" || !Array.isArray(b.messages)) return { body, wanted: true, model: "" }
  const wanted = b.stream === true
  const model = String(b.model || "")
  if (NO_THINKING.has(model)) for (const k of STRIP_WHEN_NO_THINKING) delete b[k]
  const given = Number(b.max_tokens)
  if (Number.isFinite(given) && given >= TINY_MAX_TOKENS) b.max_tokens = given + THINKING_ALLOWANCE
  if (typeof b.temperature === "number") b.temperature = Math.min(2, Math.max(0, b.temperature))
  if (typeof b.top_p === "number") b.top_p = Math.min(1, Math.max(0, b.top_p))
  if (b.stream_options === undefined) b.stream_options = { include_usage: true }
  b.stream = true
  return { body: JSON.stringify(b), wanted, model }
}

// aggregated is a streamed answer folded into the one JSON body the agent
// asked for: every chunk's deltas accumulated, the usage the last chunk
// carries kept.
async function aggregated(res, fallbackModel) {
  const text = await res.text()
  const again = (body, type = "application/json") => {
    const headers = new Headers(res.headers)
    headers.set("content-type", type)
    headers.delete("content-length")
    headers.delete("content-encoding")
    return new Response(body, { status: res.status, statusText: res.statusText, headers })
  }
  if (!text.includes("data:")) return again(text)
  const acc = { id: "", created: 0, model: fallbackModel, content: "", reasoning: "", finish: null, usage: null, toolCalls: new Map() }
  for (let line of text.split("\n")) {
    line = line.trim()
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    let v
    try {
      v = JSON.parse(data)
    } catch {
      continue
    }
    if (v?.id && !acc.id) acc.id = v.id
    if (v?.created && !acc.created) acc.created = v.created
    if (v?.model) acc.model = v.model
    if (v?.usage) acc.usage = v.usage
    const at = v?.choices?.[0] ?? {}
    const d = at.delta ?? at.message ?? {}
    if (typeof d.content === "string") acc.content += d.content
    if (typeof d.reasoning_content === "string") acc.reasoning += d.reasoning_content
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const i = tc.index ?? 0
      const call = acc.toolCalls.get(i) || { id: "", type: "function", function: { name: "", arguments: "" } }
      if (tc.id) call.id = tc.id
      if (tc.type) call.type = tc.type
      // the name comes once, on the first piece; arguments gather
      if (tc.function?.name && !call.function.name) call.function.name = tc.function.name
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments
      acc.toolCalls.set(i, call)
    }
    if (at.finish_reason) acc.finish = at.finish_reason
  }
  const message = { role: "assistant", content: acc.content }
  if (acc.reasoning) message.reasoning_content = acc.reasoning
  if (acc.toolCalls.size)
    message.tool_calls = [...acc.toolCalls.entries()].sort((x, y) => x[0] - y[0]).map(([, call]) => call)
  return again(JSON.stringify({
    id: acc.id || "chatcmpl-" + randomUUID(),
    object: "chat.completion",
    created: acc.created || Math.floor(Date.now() / 1000),
    model: acc.model || fallbackModel,
    choices: [{ index: 0, message, finish_reason: acc.finish || "stop", logprobs: null }],
    usage: acc.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }))
}

// EXHAUSTED_HINT says what the user can do about a chat refused for credits;
// OfficeAce's account holds packages, and one with none left is refused.
const EXHAUSTED_HINT = "this OfficeAce account's credits are spent; check the account's packages"
const EXHAUSTED = /insufficient (points?|quota|balance)|points? (exhausted|ran out)|积分(不足|已用尽)/i

// explained is a refused chat with the credits hint added to that refusal's
// message. It says the sign-in is kept on every refusal: a gateway 401 is
// about the Basic key, which never ends, and marking the account would only
// stop chats that a retry may pass.
async function explained(res) {
  const text = await res.text()
  const again = (body) => {
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    headers.set("X-Magpie-Sign-In", "kept")
    return new Response(body, { status: res.status, statusText: res.statusText, headers })
  }
  if (!EXHAUSTED.test(text)) return again(text)
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  const at = v?.error && typeof v.error === "object" ? v.error : v && typeof v === "object" ? v : null
  let msg = text.trim()
  if (typeof at?.message === "string") msg = at.message
  else if (typeof v?.error_msg === "string" && v.error_msg) msg = v.error_msg
  else if (typeof v?.msg === "string" && v.msg) msg = v.msg
  const headers = new Headers(res.headers)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(JSON.stringify({ error: { message: `${msg} — ${EXHAUSTED_HINT}`, type: "insufficient_quota", code: null } }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

// gatewayFetch is the fetch every chat of an account goes through: the
// account's Basic key on it, the body mended, a refusal explained, a stream
// folded back together for an agent that asked for one piece.
function gatewayFetch(a) {
  return async (input, init) => {
    const req = input instanceof Request ? input : null
    const headers = new Headers(init?.headers ?? req?.headers)
    headers.delete("authorization")
    headers.delete("x-api-key")
    headers.delete("content-length")
    headers.set("Authorization", basicOf(a))
    headers.set("User-Agent", UA)
    let body = init?.body
    if (body === undefined && req) body = await req.clone().text()
    const fit = fitBody(body)
    const res = await fetch(req ? req.url : input, { ...init, method: init?.method ?? req?.method, headers, body: fit.body })
    if (res.status >= 400) return explained(res)
    return fit.wanted ? res : aggregated(res, fit.model)
  }
}

// current is the account with credentials that work: renewed when they are
// about to end, and a renewal's result saved to the account.
async function current(client, auth) {
  return fresh(auth, async (next) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER }, body: next })
    } catch {}
  })
}

// ---- the plugin -----------------------------------------------------------------

function makePlugin() {
  return async ({ client }) => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {}
      const p = config.provider[PROVIDER]
      p.name ??= "OfficeAce"
      p.npm ??= NPM
      p.api ??= DEFAULT_GATEWAY + "/v2"
      p.models = { ...staticModels(), ...(p.models ?? {}) }
    },
    provider: {
      id: PROVIDER,
      // the account's own list, when its gateway answers; else the list above
      async models(provider, { auth } = {}) {
        if (!basicOf(auth)) return provider.models
        try {
          const a = auth.type === "api" ? { ...auth.metadata, authorization: auth.key } : await current(client, auth)
          const ms = await liveModels(a)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, modelOf(provider, { ...m, baseUrl: a.baseUrl })]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER,
      // magpie renews the temporary credentials an hour before they end (a
      // day's credentials), once for the account, before its requests, models
      // and usage ask; the check before each request stays for OpenCode.
      refreshLead: LEAD_MS,
      refresh: (auth) => refreshed(auth),
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type === "api") {
          if (!auth.key) return {}
          return {
            baseURL: baseUrlOf(auth.metadata),
            apiKey: "",
            fetch: gatewayFetch({ authorization: auth.key, baseUrl: auth.metadata?.baseUrl }),
          }
        }
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: baseUrlOf(auth),
          apiKey: "",
          async fetch(input, init) {
            let a = await getAuth()
            if (a?.type !== "oauth") throw new Error("OfficeAce isn't signed in")
            a = await current(client, a)
            return gatewayFetch(a)(input, init)
          },
        }
      },
      // the account's credits, as the OfficeAce client's subscription card
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type === "api") return { plan: "Gateway key", windows: [], signIn: "kept" }
        if (auth?.type !== "oauth" || (!auth.access && !auth.refresh)) return { error: "not signed in", signIn: "kept" }
        try {
          const a = await current(client, auth)
          if (!a.access || !a.secret) return { error: "this account's credentials have ended; sign in again", signIn: "kept" }
          const sub = await subscriptionOf(a)
          if (!sub) return { error: "OfficeAce's subscription gave nothing", signIn: "kept" }
          if (sub.error_code || sub.error)
            return { error: `${sub.error_msg || sub.error}${sub.error_code ? ` (${sub.error_code})` : ""}`, signIn: "kept" }
          return { ...usageOf(sub), signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      // the day's rewards, as the subscription card's claim takes them: one
      // idempotent POST, the balance read before and after to say what came.
      // The same call hands over the daily sign-in reward and any one-time
      // newcomer gift, so there is nothing else to press.
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type === "api")
          return { outcome: "inactive", message: "an imported gateway key has no claim credentials" }
        if (auth?.type !== "oauth" || !auth.access || !auth.secret)
          return { outcome: "failed", message: "OfficeAce isn't signed in; sign in again in magpie" }
        try {
          const a = await current(client, auth)
          if (!a.access || !a.secret)
            return { outcome: "failed", message: "the account's control-plane credentials have ended; sign in again in magpie" }
          if (a.expires && Date.now() >= a.expires)
            return { outcome: "failed", message: "the account's temporary credentials have ended; let magpie renew the account, or sign in again" }

          // A balance read that fails for another reason doesn't block the
          // claim; a refused sign-in does.
          const read = await controlCall(a, "GET", "/v1/subscription")
          if (read.status === 401 || read.status === 403)
            return { outcome: "failed", message: "the subscription was refused; let magpie renew the account, or sign in again" }
          if (read.status === 429) return { outcome: "failed", message: "the subscription is rate limited; retry later" }
          const before = baselineOf(read)

          const claim = await claimBonus(a)
          if (claim.status === 401 || claim.status === 403)
            return { outcome: "failed", message: "the claim was refused; let magpie renew the account, or sign in again" }
          if (claim.status === 429) return { outcome: "failed", message: "the claim is rate limited; retry later" }
          if (!claim.ok) {
            const why = redacted(a, vendorError(claim.json) || claim.text)
            return { outcome: "failed", message: `the claim failed: HTTP ${claim.status}${why ? `: ${why}` : ""}` }
          }
          const why = redacted(a, vendorError(claim.json))
          if (why) return { outcome: "failed", message: `the claim was refused: ${why}` }

          // The claim answer carries only what this claim granted (empty
          // when today was already settled), not the ledger: read the
          // subscription again for the full balance. A failed re-read must
          // not turn a claim that succeeded into a retryable failure.
          let updated = null
          try {
            updated = await controlCall(a, "GET", "/v1/subscription")
          } catch {}
          const after = baselineOf(updated)
          if (!before || !after) return { outcome: "done", message: "check-in acknowledged (balance unavailable)" }
          const gained = Math.floor(gainedBetween(before, after))
          if (gained > 0) return { outcome: "claimed", credit: gained, message: `claimed ${gained} credits` }
          return { outcome: "done", message: "no reward left to claim today" }
        } catch (e) {
          return { outcome: "failed", message: redacted(auth, e?.message ?? String(e)) }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "OfficeAce account (browser)",
          async authorize() {
            const state = await fetchState()
            const { verifier, challenge } = await pkce()
            const { privateJwk, publicJwk } = await dpopKeyPair()
            return {
              url: authorizeUrl({ state, challenge }),
              instructions: "Sign in to your Huawei Cloud account in the browser; this finishes by itself.",
              method: "auto",
              async callback() {
                try {
                  const deadline = Date.now() + SIGN_IN_MS
                  const code = await pollCode(state, deadline)
                  let a = await exchange(code, { verifier, dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk })
                  const info = await permission(a)
                  if (!info.appKey && !info.baseUrl) throw new Error("the account has no model gateway; is its OfficeAce plan active?")
                  a = { ...a, baseUrl: info.baseUrl, appKey: info.appKey, appSecret: info.appSecret, accountId: info.accountId }
                  return success(a, a.userName || info.accountId.slice(0, 8) || PROVIDER)
                } catch (e) {
                  return { type: "failed", error: e?.message ?? String(e) }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Gateway key (imported)",
          prompts: [
            {
              type: "text",
              key: "baseUrl",
              message: "Gateway base URL",
              placeholder: "https://modelgw-….huaweicloud-agentarts.com/v2",
              validate: (v) => (/^https:\/\//.test(String(v ?? "").trim()) ? undefined : "an https:// URL"),
            },
            {
              type: "text",
              key: "key",
              message: "Authorization",
              placeholder: "Basic base64(appKey:appSecret)",
              validate: (v) => (String(v ?? "").trim() ? undefined : "the gateway's Authorization value"),
            },
          ],
          async authorize(inputs) {
            const baseUrl = String(inputs?.baseUrl ?? "").trim().replace(/\/+$/, "")
            const key = String(inputs?.key ?? "").trim()
            if (!/^https:\/\//.test(baseUrl)) return { type: "failed", error: "the gateway's base URL, starting https://" }
            if (!key) return { type: "failed", error: "the gateway's Authorization value" }
            return { type: "success", key, metadata: { baseUrl } }
          },
        },
      ],
    },
  })
}

// current is used by the hooks above; declared here to keep the plugin last.
export const OfficeAceAuthPlugin = makePlugin()

// for tests
export const _internal = {
  PROVIDER, CLOUD_BASE, AUTH_BASE, TOKEN_URL, CLIENT_ID, REDIRECT_URI, REGION,
  DEFAULT_GATEWAY, UA, MODELS, USED_TOKEN_CODES, EARLY_MS, LEAD_MS,
  signV4, signV11, dpopProof, dpopKeyPair, pkce,
  baseUrlOf, hostOf, basicOf,
  mergeToken, claimsOf, refreshable, stale, fresh, renew, renewed, renewing, refreshed,
  permission, controlCall, subscriptionOf, claimBonus, bonusList, gainedBetween, vendorError, redacted,
  usageOf, liveModels,
  authorizeUrl, pollCode, exchange, success,
  fitBody, aggregated, explained, gatewayFetch, NO_THINKING, TINY_MAX_TOKENS, THINKING_ALLOWANCE,
  EXHAUSTED, EXHAUSTED_HINT,
}
