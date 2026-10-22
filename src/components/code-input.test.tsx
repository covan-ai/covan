import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeInput } from "./code-input";

function Harness() {
  const [code, setCode] = useState("");
  return (
    <form data-testid="form">
      <CodeInput name="code" value={code} onChange={setCode} />
    </form>
  );
}

const hidden = () =>
  (screen.getByTestId("form") as HTMLFormElement).querySelector<HTMLInputElement>(
    'input[name="code"]',
  )!;

describe("CodeInput", () => {
  it("moves along the boxes as digits are typed, and the form reads them as one", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Digit 1"), "482");
    expect(screen.getByLabelText("Digit 3")).toHaveValue("2");
    expect(screen.getByLabelText("Digit 4")).toHaveFocus();
    expect(hidden().value).toBe("482");
  });

  it("fills every box from a pasted code read aloud with a space", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Digit 1"));
    await userEvent.paste("123 456");
    expect(hidden().value).toBe("123456");
    expect(screen.getByLabelText("Digit 6")).toHaveValue("6");
  });

  it("takes the digit before an empty box back with Backspace", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Digit 1"), "48");
    await userEvent.keyboard("{Backspace}");
    expect(hidden().value).toBe("4");
    expect(screen.getByLabelText("Digit 2")).toHaveFocus();
  });
});
