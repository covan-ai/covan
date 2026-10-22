import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysSection } from "@/components/api-keys-section";
import { WebhooksSection } from "@/components/webhooks-section";

export const Route = createFileRoute("/_authed/settings/api-keys")({
  component: ApiKeysSettingsPage,
  head: () => ({
    meta: [
      { title: "API keys — Settings — Covan" },
      {
        name: "description",
        content: "Keys that act as you in Covan's API, and the webhooks the workspace sends.",
      },
    ],
  }),
});

/** Settings › API keys (A26): your keys, then the workspace's webhooks. */
function ApiKeysSettingsPage() {
  return (
    <>
      <ApiKeysSection />
      <div className="mt-8">
        <WebhooksSection />
      </div>
    </>
  );
}
