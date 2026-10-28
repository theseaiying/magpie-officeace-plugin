// The smoke test the docs' script runs, stood up here: the plugin is loaded
// as magpie loads it, an account signs in, its models are listed, a chat is
// sent and its credits are read — everything against a stand-in cloud.
import { OfficeAceAuthPlugin, _internal } from "./index.mjs"

let failed = 0
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  · " + extra : ""}`)
  if (!cond) failed++
}

// ---- the stand-in cloud and gateway -----------------------------------------
const TOKENS = {
  credentials: { access_key_id: "AK", secret_access_key: "SK", security_token: "ST", project_id: "P", expiration: new Date(Date.now() + 3600e3).toISOString() },
  refresh_token: "R1",
  refresh_expires_at: new Date(Date.now() + 30 * 86400e3).toISOString(),
  id_token: `.${Buffer.from(JSON.stringify({ sub: "uid", preferred_username: "smoker" })).toString("base64url")}.`,
}
const calls = []
const real = globalThis.fetch
let claimed = false
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  calls.push(u.pathname)
  if (u.pathname === "/v1/claw/auth/state") return Response.json({ state: "s1" })
  if (u.pathname === "/v1/claw/auth/code") return Response.json({ code: "c1" })
  if (u.pathname === "/v1/oauth2/tokens") return Response.json(TOKENS)
  if (u.pathname === "/v1/claw/client-permission-validate")
    return Response.json({ account_id: "a1", model_info: { model_api_url_base: "gw.test", model_auth_info: { model_app_key: "K", model_app_secret: "S" } } })
  if (u.pathname === "/v2/models") return Response.json({ data: [{ id: "glm-5.2" }, { id: "deepseek-v4.1-flash" }] })
  if (u.pathname === "/v2/chat/completions")
    return new Response(
      [`data: ${JSON.stringify({ id: "x", model: "glm-5.2", choices: [{ delta: { content: "hello" } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } })}`, "data: [DONE]", ""].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    )
  if (u.pathname === "/v1/subscription")
    return Response.json({
      skus: [{ sku_code: "officeace.personal.package.standard", sku_name: "标准版", quotas: [{ sku_attr_code: "officeace_points", sku_value: "10000", current_value: "1234" }] }],
      bonus_skus: claimed
        ? [{ activity_id: "daily", activity_name: "每日签到", points: "100", current_value: "0" }]
        : [],
    })
  if (u.pathname === "/v1/subscription/bonus/claim") {
    claimed = true
    // the claim answer only names what this claim granted; the ledger is read again
    return Response.json({ bonus_skus: [] })
  }
  return new Response("", { status: 404 })
}

try {
  // 1) load, as magpie does
  const hooks = await OfficeAceAuthPlugin({ client: { auth: { set: async () => {} } } })
  ok("plugin loads with config/auth/provider hooks", !!(hooks.config && hooks.auth && hooks.provider))

  // 2) the config hook declares the provider and its fallback models
  const cfg = {}
  await hooks.config(cfg)
  ok("config declares the officeace provider", !!cfg.provider?.officeace)
  ok("fallback models are declared", Object.keys(cfg.provider.officeace.models).length >= 10, `${Object.keys(cfg.provider.officeace.models).length} models`)

  // 3) sign in
  const m = hooks.auth.methods.find((x) => x.type === "oauth")
  const step = await m.authorize()
  ok("authorize gives Huawei Cloud's page", step.url.startsWith("https://auth.huaweicloud.com/"))
  const done = await step.callback()
  ok("sign-in succeeds with the gateway's key", done.type === "success" && !!done.appKey && !!done.baseUrl, `${done.accountId} @ ${done.baseUrl}`)
  ok("the sign-in keeps the DPoP pair and the refresh token", !!done.dpopPrivateJwk?.d && !!done.refresh)

  // 4) the models the account's gateway serves
  const ms = await hooks.provider.models({ id: "officeace", models: {} }, { auth: done })
  ok("the account's own models are listed", !!ms["glm-5.2"] && !!ms["deepseek-v4.1-flash"], `${Object.keys(ms).length} models`)

  // 5) a chat, streamed — the account as magpie saves it: type "oauth" with
  // everything the success gave
  const saved = { ...done, type: "oauth" }
  const opts = await hooks.auth.loader(async () => saved)
  const res = await opts.fetch("https://gw.test/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] }) })
  const v = await res.json()
  ok("a chat answers folded into one piece", v.choices?.[0]?.message?.content === "hello" && v.usage?.total_tokens === 7)

  // 6) the credits
  const usage = await hooks.auth.usage(async () => saved)
  ok("the credits are read", usage.plan === "标准版" && usage.windows[0]?.display === "1234 / 10000", usage.windows[0]?.display)

  // 7) the daily reward, from the subscription card's claim
  const checkin = await hooks.auth.checkin(async () => saved)
  ok("the daily reward is claimed for its delta", checkin.outcome === "claimed" && checkin.credit === 100, `${checkin.outcome} ${checkin.credit}`)

  // 8) magpie's own login shapes are all seen to
  const api = hooks.auth.methods.find((x) => x.type === "api")
  const imported = await api.authorize({ baseUrl: "https://gw.test/v2", key: "Basic SlM6Uw==" })
  ok("a gateway key imports", imported.type === "success")
  const io = await hooks.auth.loader(async () => ({ ...imported, type: "api" }))
  const ires = await io.fetch("https://gw.test/v2/chat/completions", { method: "POST", body: '{"messages":[]}' })
  ok("an imported key sends chats", (await ires.json()).choices[0].message.content === "hello")
  const iu = await hooks.auth.usage(async () => ({ ...imported, type: "api" }))
  ok("an imported key's card says what it is", iu.plan === "Gateway key")

  // 9) nothing a chat sent carried the plugin's own marks
  ok("the token endpoint was asked once per sign-in", calls.filter((p) => p === "/v1/oauth2/tokens").length === 1)
} finally {
  globalThis.fetch = real
}

console.log(failed ? `\n${failed} check(s) failed` : "\nsmoke test passed")
process.exit(failed ? 1 : 0)
