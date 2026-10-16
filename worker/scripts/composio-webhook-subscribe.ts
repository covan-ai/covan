/**
 * Point this deployment's Composio project at `POST /composio/events`, once.
 *
 *   COMPOSIO_API_KEY=… bun run scripts/composio-webhook-subscribe.ts https://api.example.com
 *
 * Composio delivers every trigger in a project to one webhook subscription, and
 * makes the subscription through its API rather than through anything a
 * request here could do. This script:
 *
 *   1. checks that every trigger type the catalogue names still exists at
 *      Composio (`lib/routines/events/composio-catalog.ts`) — a renamed slug
 *      would otherwise surface as a routine that fails to subscribe;
 *   2. makes the project's subscription, or updates the one it has, to deliver
 *      the three event kinds the route understands, as V3 payloads;
 *   3. prints the signing secret, which is set on BOTH Workers as
 *      `COMPOSIO_WEBHOOK_SECRET`.
 *
 * Re-running it is safe: there is one subscription per project, and it is
 * updated in place. Running it against a project another deployment also uses
 * moves that deployment's deliveries here — one Composio project per
 * deployment.
 *
 * The secret is printed to this terminal and nowhere else. It is not written
 * to a file.
 */

import { ensureWebhookSubscription, getTriggerType } from "../src/lib/composio/client";
import { COMPOSIO_EVENTS } from "../src/lib/routines/events/composio-catalog";

const EVENTS = [
  "composio.trigger.message",
  "composio.connected_account.expired",
  "composio.trigger.disabled",
];

async function main(): Promise<number> {
  const env = {
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
    COMPOSIO_BASE_URL: process.env.COMPOSIO_BASE_URL,
  };
  if (!env.COMPOSIO_API_KEY) {
    console.error("Set COMPOSIO_API_KEY to the project key this deployment uses.");
    return 1;
  }
  const origin = (process.argv[2] ?? "").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${origin}/composio/events`);
  } catch {
    console.error("Usage: bun run scripts/composio-webhook-subscribe.ts https://<your API host>");
    return 1;
  }
  if (url.protocol !== "https:") {
    console.error("Composio delivers to https addresses only.");
    return 1;
  }

  console.log("Checking the catalogue's trigger types…");
  let missing = 0;
  for (const spec of COMPOSIO_EVENTS) {
    const res = await getTriggerType(env, spec.slug);
    if (res.kind === "error") {
      missing += 1;
      console.error(
        `  ✗ ${spec.slug} (${spec.def.id}): ${res.status} ${res.message.slice(0, 200)}`,
      );
    } else {
      console.log(`  ✓ ${spec.slug} (${res.type || "?"})`);
    }
  }
  if (missing > 0) {
    console.error(
      `${missing} trigger type(s) are not known to Composio. Nothing was changed; ` +
        "fix the catalogue first.",
    );
    return 1;
  }

  const res = await ensureWebhookSubscription(env, {
    webhookUrl: url.toString(),
    enabledEvents: EVENTS,
  });
  if (res.kind === "error") {
    console.error(`Composio refused the subscription: ${res.status} ${res.message}`);
    return 1;
  }
  const sub = res.subscription;
  console.log(`\n${res.created ? "Created" : "Updated"} webhook subscription ${sub.id}`);
  console.log(`  delivers to: ${sub.webhookUrl}`);
  console.log(`  events:      ${sub.enabledEvents.join(", ")}`);
  console.log(`  payloads:    ${sub.version}`);
  if (!sub.secret) {
    console.error(
      "\nComposio did not return the signing secret. Read it from the subscription in " +
        "Composio's dashboard.",
    );
    return 1;
  }
  console.log("\nSet this on both Workers (API and cron):");
  console.log("  wrangler secret put COMPOSIO_WEBHOOK_SECRET");
  console.log("  wrangler secret put COMPOSIO_WEBHOOK_SECRET -c wrangler.cron.toml");
  console.log(`\nCOMPOSIO_WEBHOOK_SECRET=${sub.secret}`);
  return 0;
}

process.exit(await main());
