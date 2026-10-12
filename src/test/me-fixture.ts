import type { Me } from "@/lib/api-client";

/**
 * A `Me` for tests, with the parts a settings page reads filled in.
 *
 * `role` puts the caller into `members` with that role, which is what every
 * role check in the app reads; `members` adds the other people. Everything else
 * is a patch over the defaults.
 */
export function meFixture({
  role = "admin",
  user = {},
  workspace = {},
  members = [],
}: {
  role?: string;
  user?: Partial<Me["user"]>;
  workspace?: Partial<Me["workspace"]>;
  members?: Me["members"];
} = {}): Me {
  const self = { id: "u1", name: "Ada", email: "ada@acme.test", avatarUrl: null, ...user };
  return {
    user: self,
    workspace: {
      id: "w1",
      name: "Acme",
      slug: "acme",
      defaultModel: null,
      gapReportEnabled: false,
      ...workspace,
    },
    members: [
      { id: self.id, name: self.name, email: self.email, role, avatarUrl: self.avatarUrl },
      ...members,
    ],
    models: [],
    modelSpecs: {},
    modelCosts: {},
    onboarding: { completed: true, answers: {} },
  } as unknown as Me;
}
