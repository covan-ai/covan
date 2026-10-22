import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import type React from "react";
import { meFixture } from "@/test/me-fixture";
import { renderRoute, stub } from "@/test/settings-route";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
}));

const me = meFixture({ user: { name: "Ada Lovelace" } });
vi.mock("@/lib/api-client", () => ({
  api: { me: () => Promise.resolve(me) },
}));
vi.mock("@/components/account/profile-form", () => ({
  ProfileForm: ({ user }: { user?: { name: string | null } }) => (
    <div data-testid="profile">{user?.name}</div>
  ),
}));
vi.mock("@/components/account/email-card", () => ({ EmailCard: stub("email") }));
vi.mock("@/components/account/password-card", () => ({ PasswordCard: stub("password") }));
vi.mock("@/components/account/two-factor-card", () => ({ TwoFactorCard: stub("two-factor") }));
vi.mock("@/components/preferences-section", () => ({
  PersonalPreferencesSection: stub("preferences"),
}));
vi.mock("@/components/routines/delivery-channels-card", () => ({
  DeliveryChannelsCard: stub("delivery-channels"),
}));
vi.mock("@/components/api-keys-section", () => ({ ApiKeysSection: stub("api-keys") }));
vi.mock("@/components/browser-signins-section", () => ({
  BrowserSignInsSection: stub("browser-signins"),
}));
vi.mock("@/components/close-account-section", () => ({
  CloseAccountSection: stub("close-account"),
}));

const { Route } = await import("./_authed.settings.security");

describe("/settings/security", () => {
  it("holds the password and the second step", () => {
    renderRoute(Route);
    expect(screen.getByTestId("password")).toBeInTheDocument();
    expect(screen.getByTestId("two-factor")).toBeInTheDocument();
  });
});
