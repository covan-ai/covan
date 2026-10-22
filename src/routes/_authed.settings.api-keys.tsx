import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { ApiKeysSection } from "@/components/api-keys-section";

export const Route = createFileRoute("/_authed/settings/api-keys")({
  component: ApiKeysSettingsPage,
  head: () => ({
    meta: [
      { title: "API keys — Settings — Covan" },
      { name: "description", content: "Keys that act as you in Covan's API." },
    ],
  }),
});

function ApiKeysSettingsPage() {
  return (
    <>
      <SectionTitle
        title="API keys"
        lede="A key acts as you. It can do exactly what you can and nothing more, so there are no scopes to get wrong."
      />
      {/* Hides itself where the deployment cannot honour a key at all. */}
      <ApiKeysSection />
    </>
  );
}
