import { describe, it, expect, vi, afterEach } from "vitest";
import { meteredFetch, subrequestMeter, subrequestReport, withMeter, WARN_AT } from "./subrequests";
import { runtimeLimitFlag } from "./runtime-limit";

/**
 * The counter that lets a turn say "ask for something narrower" before the
 * platform says `Connection error.`
 *
 * What is worth testing here is not the arithmetic — it is the two things that
 * would make the count a lie: a meter that does not reach the calls it is
 * supposed to count, and a meter written onto the shared bindings object rather
 * than onto a copy of it.
 */

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Stand in for the platform's own `fetch`, so nothing leaves the process. */
function stubFetch() {
  const sent = vi.fn(async () => new Response("ok"));
  globalThis.fetch = sent as unknown as typeof fetch;
  return sent;
}

describe("counting what the platform counts", () => {
  it("sizes itself to the plan, because that is what the ceiling is", () => {
    expect(subrequestMeter({}, runtimeLimitFlag()).limit).toBe(50);
    expect(subrequestMeter({ WORKER_PLAN: "paid" }, runtimeLimitFlag()).limit).toBe(10_000);
  });

  it("counts a call and still makes it", async () => {
    const sent = stubFetch();
    const meter = subrequestMeter({ WORKER_PLAN: "paid" }, runtimeLimitFlag());
    const counting = meteredFetch(withMeter({}, meter))!;

    await counting("https://example.test/a");
    await counting("https://example.test/b");

    expect(meter.count).toBe(2);
    // Counting is not intercepting. A wrapper that forgot to forward would show
    // a healthy count and a product that does nothing.
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("says so before the platform does, not after", async () => {
    // The whole point. Past the cap every `fetch` fails and the OpenAI SDK
    // reports it as `Connection error.`, so the honest sentence has to be
    // decided while calls still work.
    stubFetch();
    const runtimeLimit = runtimeLimitFlag();
    const meter = subrequestMeter({}, runtimeLimit);
    const counting = meteredFetch(withMeter({}, meter))!;

    const warnsAt = Math.ceil(meter.limit * WARN_AT);
    for (let i = 0; i < warnsAt - 1; i += 1) await counting("https://example.test/");
    expect(runtimeLimit.hit).toBe(false);

    await counting("https://example.test/");
    expect(runtimeLimit.hit).toBe(true);
    // And with calls still to spare, which is what makes the sentence arrive in
    // time to be useful.
    expect(meter.count).toBeLessThan(meter.limit);
  });

  it("counts nothing when nothing asked it to", () => {
    // Every caller outside a request — the cron Worker's whole tick, a test —
    // gets no meter, and the factories then omit the option rather than passing
    // `undefined`, which is not the same thing to every SDK.
    expect(meteredFetch({})).toBeUndefined();
  });

  it("never writes on the bindings it was given", () => {
    // The bindings object is shared between every request an isolate serves. A
    // meter written onto it would count one person's turn against another's.
    const bindings = { SUPABASE_URL: "https://db.test" };
    const overlaid = withMeter(bindings, subrequestMeter({}, runtimeLimitFlag()));

    expect(bindings).not.toHaveProperty("SUBREQUESTS");
    expect(overlaid).toHaveProperty("SUBREQUESTS");
    expect(overlaid.SUPABASE_URL).toBe("https://db.test");
  });

  it("reports what it counted rather than claiming a total", () => {
    // It cannot see the token check that runs before a caller exists, so the
    // number is a floor. The wording is what stops the next person reading it
    // as exact and re-deriving a budget from it.
    const meter = subrequestMeter({ WORKER_PLAN: "paid" }, runtimeLimitFlag());
    meter.count = 300;
    expect(subrequestReport(meter)).toBe("subrequests: 300 counted of 10000 allowed (3%)");
  });
});
