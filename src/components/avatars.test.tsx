import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserAvatar } from "./avatars";

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://api.covan.test");
});

describe("UserAvatar", () => {
  it("loads an uploaded photo from the API", () => {
    render(<UserAvatar name="Ada Lovelace" url="/avatars/u1/abc.webp" />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://api.covan.test/avatars/u1/abc.webp",
    );
  });

  it("draws a monogram instead of loading an address the app would not have stored", () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" url="javascript:alert(1)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("AL");
  });
});
