import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@/lib/api-client";

const { update, uploadAvatar, removeAvatar, resizeAvatar, toastError } = vi.hoisted(() => ({
  update: vi.fn(),
  uploadAvatar: vi.fn(),
  removeAvatar: vi.fn(),
  resizeAvatar: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: { profile: { update, uploadAvatar, removeAvatar } },
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/avatar-resize", () => ({ resizeAvatar }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));
vi.mock("@/lib/timezones", () => ({
  listTimeZones: () => ["UTC", "Europe/Istanbul", "Asia/Tokyo"],
  browserTimeZone: () => "Europe/Istanbul",
  timeZoneLabel: (z: string) => z.replace(/\//g, " / "),
}));

const { ProfileForm } = await import("./profile-form");

const user: Me["user"] = {
  id: "u1",
  name: "Ada",
  email: "ada@acme.test",
  avatarUrl: null,
  bio: "Runs ops.",
  locale: null,
  timezone: null,
};

let client: QueryClient;
function renderForm(patch: Partial<Me["user"]> = {}) {
  client = new QueryClient();
  vi.spyOn(client, "invalidateQueries");
  return render(
    <QueryClientProvider client={client}>
      <ProfileForm user={{ ...user, ...patch }} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue(user);
  uploadAvatar.mockResolvedValue(user);
  removeAvatar.mockResolvedValue(user);
});

describe("ProfileForm", () => {
  it("starts from what is saved, with nothing to save", () => {
    renderForm();
    expect(screen.getByLabelText("Display name")).toHaveValue("Ada");
    expect(screen.getByLabelText("About you")).toHaveValue("Runs ops.");
    expect(screen.getByText("9/280")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  });

  it("sends only what changed", async () => {
    renderForm();
    const bio = screen.getByLabelText("About you");
    await userEvent.clear(bio);
    await userEvent.type(bio, "Runs ops and payroll.");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(update).toHaveBeenCalledWith({ bio: "Runs ops and payroll." });
    await waitFor(() =>
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["me"] }),
    );
  });

  it("clears the line about you with null rather than an empty string", async () => {
    renderForm();
    await userEvent.clear(screen.getByLabelText("About you"));
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(update).toHaveBeenCalledWith({ bio: null });
  });

  it("picks a time zone from a searchable list", async () => {
    renderForm();
    const zone = screen.getByRole("button", { name: "Time zone" });
    expect(zone).toHaveTextContent("Follow the device");
    await userEvent.click(zone);
    await userEvent.click(await screen.findByText("Asia / Tokyo"));
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(update).toHaveBeenCalledWith({ timezone: "Asia/Tokyo" });
  });

  it("uploads a picked photo once it has been resized, and refreshes you everywhere", async () => {
    const small = new Blob(["x"], { type: "image/webp" });
    resizeAvatar.mockResolvedValue(small);
    renderForm();

    const photo = new File(["big"], "me.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Photo"), photo);

    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledWith(small));
    expect(resizeAvatar).toHaveBeenCalledWith(photo);
    await waitFor(() =>
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["me"] }),
    );
  });

  it("says why a photo was refused", async () => {
    resizeAvatar.mockResolvedValue(new Blob(["x"]));
    uploadAvatar.mockRejectedValue(new Error("only PNG, JPEG or WebP photos"));
    renderForm();

    await userEvent.upload(
      screen.getByLabelText("Photo"),
      new File(["x"], "me.png", { type: "image/png" }),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("only PNG, JPEG or WebP photos"));
  });

  it("offers Remove only when there is a photo", async () => {
    const { unmount } = renderForm();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    unmount();

    renderForm({ avatarUrl: "/avatars/u1/abc.webp" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeAvatar).toHaveBeenCalled();
  });
});
