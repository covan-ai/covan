import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventPicker } from "./event-picker";
import type { EventCatalogEntry } from "@/lib/routines-api";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const TELEGRAM: EventCatalogEntry = {
  type: "telegram.new_message",
  provider: "telegram",
  app: "Telegram",
  label: "Message to your bot",
  description: "A paired chat sends the bot a message.",
  fields: [{ key: "botToken", label: "Bot token", kind: "secret", placeholder: "123456789:AA…" }],
  requires: { kind: "none" },
  connected: true,
};

describe("EventPicker", () => {
  // A bot token is a credential: masked, and nothing for the browser to keep.
  it("draws a secret field as a password box the browser does not fill", () => {
    render(
      <EventPicker
        catalog={[TELEGRAM]}
        value={{ type: TELEGRAM.type, config: {} }}
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText("Bot token");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
  });
});
