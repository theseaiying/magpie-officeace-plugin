// auth.usage: the account's credits, from its subscription at the gateway,
// as the OfficeAce client's card reads them (total minus used, the expired
// entries not counted).
import { test, expect, afterEach, setSystemTime } from "bun:test"
import { OfficeAceAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  setSystemTime()
})

const ok = (data) => new Response(JSON.stringify(data), { status: 200 })

function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init?.headers) })
    const r = routes[u.pathname]
    return r ? r(init) : new Response("", { status: 404 })
  }
  return calls
}

const auth = (over = {}) => ({
  type: "oauth", access: "ak", secret: "sk", securityToken: "st", projectId: "p",
  expires: Date.now() + 20 * 3600 * 1000, refresh: "r", refreshExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  uid: "u1", baseUrl: "https://gw.example/v2", appKey: "key1", appSecret: "sec1",
  ...over,
})

const usageOf = async (a, client = {}) => (await OfficeAceAuthPlugin({ client })).auth.usage(async () => a)

// the subscription as the gateway sends it: string numbers, an expired quota
const SUB = {
  skus: [
    {
      sku_code: "officeace.personal.package.standard", sku_name: "标准版", subscribe_status: "SUBSCRIBED",
      expired_time: "2026-11-01T00:00:00Z",
      quotas: [
        { sku_attr_code: "officeace_points", sku_value: "10000", current_value: "1234.5", expired_time: "" },
        { sku_attr_code: "online_search_count", sku_value: "50", current_value: "10", expired_time: "" },
        { sku_attr_code: "officeace_points", sku_value: "100", current_value: "0", expired_time: "2026-10-01T00:00:00Z" }, // ended
      ],
    },
  ],
  bonus_skus: [
    { activity_id: "b1", activity_name: "签到奖励", points: "500", current_value: "100", expired_time: "2026-10-20T00:00:00Z" },
    { activity_id: "b2", activity_name: "过期奖励", points: "999", current_value: "0", expired_time: "2026-10-01T00:00:00Z" },
  ],
}

test("a plan's credits and its alive bonuses, the expired not counted", async () => {
  // the fixture's bonus ends on 2026-10-20: read the card as of the 12th,
  // when it was still alive
  setSystemTime(new Date("2026-10-12T00:00:00Z"))
  const calls = serve({ "/v1/subscription": () => ok(SUB) })
  const u = await usageOf(auth())
  expect(u.plan).toBe("标准版")
  expect(u.windows).toEqual([{
    name: "Credits",
    used: (100 * 1334.5) / 10500,
    display: "1334.5 / 10500",
    amount: 1334.5,
    limit: 10500,
    unit: "credits",
    // the bonus's 400 left end on the 20th, before the plan's on 11-01
    runsOutAt: "2026-10-20T00:00:00.000Z",
    runsOut: 400,
  }])
  expect(u.until).toBe("2026-11-01T00:00:00.000Z")
  const c = calls[0]
  expect(c.url.href).toBe("https://gw.example/v1/subscription")
  expect(c.headers.get("authorization")).toMatch(/^V11-HMAC-SHA256 /)
  expect(c.headers.get("x-subscription-type")).toBe("v2")
  expect(c.headers.get("x-security-token")).toBe("st")
})

// the soonest end credits left are lost at, and how many — for magpie's
// smart routing to spend this account's credits first, as WorkBuddy's card
// carries runsOutAt too. The SUB above has no per-quota ends, so nothing.
test("the credits that run out soonest are named, for routing to spend first", () => {
  const now = Date.parse("2026-10-12T00:00:00Z")
  // the bonus's 400 left end on the 20th, before the plan's 8765.5 on 11-01
  const u = _internal.usageOf(SUB, now)
  expect(u.windows[0].runsOutAt).toBe("2026-10-20T00:00:00.000Z")
  expect(u.windows[0].runsOut).toBe(400)
  // a quota without an end ends when the plan does, so it isn't counted
  const openEnded = { skus: [{ quotas: [{ sku_attr_code: "officeace_points", sku_value: "100", current_value: "10", expired_time: "" }] }], bonus_skus: [] }
  expect(_internal.usageOf(openEnded, now).windows[0].runsOutAt).toBeUndefined()
  // credits spent past their end, or none left, are unknown too
  const spent = { skus: [], bonus_skus: [{ points: "500", current_value: "500", expired_time: "2026-10-20T00:00:00Z" }] }
  expect(_internal.usageOf(spent, now).windows[0].runsOutAt).toBeUndefined()
})

test("a plan that gives no name is said by its tier", () => {
  const u = _internal.usageOf({ skus: [{ sku_code: "officeace.personal.package.trial", quotas: [{ sku_attr_code: "officeace_points", sku_value: 100, current_value: 0 }] }] })
  expect(u.plan).toBe("试用版")
  expect(u.windows[0].display).toBe("0 / 100")
})

test("no credits, no window; no plan, no name; an unlimited quota says no share", () => {
  expect(_internal.usageOf({ skus: [], bonus_skus: [] }).windows).toEqual([])
  expect(_internal.usageOf({}).plan).toBe("")
  // unlimited (-1) is left out: it says no share the card could draw
  expect(_internal.usageOf({ skus: [{ quotas: [{ sku_attr_code: "officeace_points", sku_value: -1, current_value: 0 }] }] }).windows).toEqual([])
})

test("OfficeAce's refusals are the card's error, the sign-in kept", async () => {
  serve({ "/v1/subscription": () => new Response("", { status: 401 }) })
  expect(await usageOf(auth())).toEqual({ error: "OfficeAce's subscription gave nothing", signIn: "kept" })
  serve({ "/v1/subscription": () => ok({ error_code: "OfficeAce.11020001", error_msg: "no subscription" }) })
  expect(await usageOf(auth())).toEqual({ error: "no subscription (OfficeAce.11020001)", signIn: "kept" })
  expect(await usageOf(null)).toEqual({ error: "not signed in", signIn: "kept" })
})

test("an imported gateway key's card says it has no credits to read", async () => {
  expect(await usageOf({ type: "api", key: "Basic a2V5OnM=" })).toEqual({ plan: "Gateway key", windows: [], signIn: "kept" })
})

test("credentials gone and nothing to renew with is the card's error", async () => {
  globalThis.fetch = async () => { throw new Error("should not be asked") }
  const u = await usageOf(auth({ access: "", secret: "", expires: Date.now() - 1000 }))
  expect(u.error).toContain("credentials have ended")
  expect(u.signIn).toBe("kept")
})
