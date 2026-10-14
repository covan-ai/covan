import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserAvatar } from "./avatars";

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://api.covan.test");
});

describe("UserAvatar", () => {
  it("loads an uploaded photo from the API", () => {
    const url =
      "/avatars/0b7e7c1e-6a43-4c38-9a59-3f1b2c4d5e6f/0123456789abcdef0123456789abcdef.webp";
    render(<UserAvatar name="Ada Lovelace" url={url} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", `https://api.covan.test${url}`);
  });

  it("draws a monogram instead of loading an address the app would not have stored", () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" url="javascript:alert(1)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("AL");
  });
});
