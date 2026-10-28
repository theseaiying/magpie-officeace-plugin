// auth.checkin: the subscription card's one idempotent claim, the balance
// read before and after to say what actually landed.
import { test, expect, afterEach } from "bun:test"
import { OfficeAceAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const access = "fake-access"
const secret = "fake-secret"
const securityToken = "fake-security-token"
const refresh = "fake-refresh"

const auth = (over = {}) => ({
  type: "oauth",
  access,
  secret,
  securityToken,
  projectId: "p",
  expires: Date.now() + 20 * 3600 * 1000,
  refresh,
  refreshExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  baseUrl: "https://gw.example/v2",
  appKey: "key",
  appSecret: "app-secret",
  accountId: "acc",
  ...over,
})

const ok = (data) => new Response(JSON.stringify(data), { status: 200 })

function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init.headers) })
    const route = routes[`${init.method || "GET"} ${u.pathname}`]
    if (!route) return new Response("not found", { status: 404 })
    // an array answers one request per response, in order: the balance is
    // read before and after the claim
    if (Array.isArray(route)) {
      const next = route.shift()
      if (!next) return new Response("not found", { status: 404 })
      return typeof next === "function" ? next(init) : next
    }
    return typeof route === "function" ? route(init) : route
  }
  return calls
}

const checkin = async (a, client = {}) => (await OfficeAceAuthPlugin({ client })).auth.checkin(async () => a)

// the subscription as the gateway sends it: the daily bonus is spent before
// the claim (current_value 100 of 100) and whole after it
const before = {
  subscribe_status: "SUBSCRIBED",
  bonus_skus: [{ activity_id: "daily", activity_name: "每日签到", points: "100", current_value: "100" }],
}
const after = {
  subscribe_status: "SUBSCRIBED",
  bonus_skus: [{ activity_id: "daily", activity_name: "每日签到", points: "100", current_value: "0" }],
}

function assertNoSecret(value) {
  const text = JSON.stringify(value)
  for (const s of [access, secret, securityToken, refresh]) expect(text).not.toContain(s)
}

test("a claim that grows the balance is claimed with the delta", async () => {
  const calls = serve({
    "GET /v1/subscription": [ok(before), ok(after)],
    // the claim answers only what this claim granted — here nothing, since
    // the change is read from the subscription again
    "POST /v1/subscription/bonus/claim": ok({ bonus_skus: [] }),
  })

  const out = await checkin(auth())

  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe(100)
  expect(out.message).toContain("100")
  expect(calls.map((c) => c.url.pathname)).toEqual([
    "/v1/subscription",
    "/v1/subscription/bonus/claim",
    "/v1/subscription",
  ])
  expect(calls[1].init.method).toBe("POST")
  expect(calls[1].init.body).toBe("{}")
  expect(calls[1].headers.get("content-type")).toBe("application/json")
  expect(calls[1].headers.get("x-subscription-type")).toBe("v2")
  expect(calls[1].headers.get("x-security-token")).toBe(securityToken)
  for (const c of calls) expect(c.headers.get("authorization")).toMatch(/^V11-HMAC-SHA256 Credential=/)
  assertNoSecret(out)
})

test("an idempotent claim that adds nothing is done", async () => {
  serve({
    "GET /v1/subscription": [ok(after), ok(after)],
    "POST /v1/subscription/bonus/claim": ok({ bonus_skus: [] }),
  })

  const out = await checkin(auth())

  expect(out.outcome).toBe("done")
  expect(out.message).toContain("no reward left")
  assertNoSecret(out)
})

test("a first-seen bonus counts its remaining, not its total", () => {
  expect(_internal.gainedBetween(
    { bonus_skus: [] },
    { bonus_skus: [{ activity_id: "new", points: "500", current_value: "400" }] },
  )).toBe(100)
  // an entry without an id is named by its activity name
  expect(_internal.gainedBetween(
    { bonus_skus: [{ activity_name: "新人礼", points: "300", current_value: "300" }] },
    { bonus_skus: [{ activity_name: "新人礼", points: "300", current_value: "0" }] },
  )).toBe(300)
})

test("an imported gateway key is inactive, not a lapsed sign-in", async () => {
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return ok({})
  }
  const out = await checkin({ type: "api", key: "Basic fake", metadata: { baseUrl: "https://gw.example/v2" } })
  expect(out.outcome).toBe("inactive")
  expect(out.message).toContain("gateway key")
  expect(called).toBe(0)
})

test("401 on the balance read fails without claiming", async () => {
  const calls = serve({ "GET /v1/subscription": [new Response("unauthorized", { status: 401 })] })
  const out = await checkin(auth())
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("sign in again")
  expect(calls.length).toBe(1)
  assertNoSecret(out)
})

test("a rate-limited claim is failed and retryable", async () => {
  serve({
    "GET /v1/subscription": [ok(after)],
    "POST /v1/subscription/bonus/claim": new Response("slow down", { status: 429 }),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("rate limited")
})

test("a vendor error is failed and a token it echoes is redacted", async () => {
  serve({
    "GET /v1/subscription": [ok(after)],
    "POST /v1/subscription/bonus/claim": new Response(
      JSON.stringify({ error_code: "OfficeAce.11020001", error_msg: `bad token ${securityToken}` }),
      { status: 500 },
    ),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("HTTP 500")
  expect(out.message).toContain("[redacted]")
  assertNoSecret(out)
})

test("a claim answer that isn't the ledger is re-read from the subscription", async () => {
  serve({
    "GET /v1/subscription": [ok(before), ok(after)],
    "POST /v1/subscription/bonus/claim": new Response("[1,2]", { status: 200 }),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe(100)
})

test("a balance read that fails another way still claims, saying the balance was unavailable", async () => {
  serve({
    "GET /v1/subscription": [new Response("boom", { status: 500 }), ok(after)],
    "POST /v1/subscription/bonus/claim": ok({ bonus_skus: [] }),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("done")
  expect(out.message).toContain("balance unavailable")
})

test("an error body read as the balance isn't taken for a baseline", async () => {
  serve({
    "GET /v1/subscription": [ok({ error_code: "OfficeAce.1001", error_msg: "temporarily unavailable" }), ok(after)],
    "POST /v1/subscription/bonus/claim": ok({ bonus_skus: [] }),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("done")
  expect(out.message).toContain("balance unavailable")
  expect(out.credit).toBeUndefined()
})

test("a balance that can't be re-read after a claim is acknowledged without a credit", async () => {
  serve({
    "GET /v1/subscription": [ok(before), new Response("boom", { status: 500 })],
    "POST /v1/subscription/bonus/claim": ok({ bonus_skus: [] }),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("done")
  expect(out.message).toContain("balance unavailable")
  expect(out.credit).toBeUndefined()
})

test("a re-read that throws doesn't turn a successful claim into a failure", async () => {
  serve({
    "GET /v1/subscription": [ok(before), () => { throw new Error("network down") }],
    "POST /v1/subscription/bonus/claim": ok({ bonus_skus: [] }),
  })
  const out = await checkin(auth())
  expect(out.outcome).toBe("done")
  expect(out.message).toContain("balance unavailable")
  expect(out.credit).toBeUndefined()
})

test("expired temporary credentials fail before any request", async () => {
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return ok({})
  }
  const out = await checkin(auth({ expires: Date.now() - 1000, refresh: "", dpopPrivateJwk: null }))
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("credentials have ended")
  expect(called).toBe(0)
})

test("an account without control-plane credentials fails before any request", async () => {
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return ok({})
  }
  const out = await checkin(auth({ access: "", secret: "" }))
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("sign in again")
  expect(called).toBe(0)
})
