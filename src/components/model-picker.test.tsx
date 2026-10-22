import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { ModelEndpoint } from "@/lib/api-client";

const create = vi.fn(async (_input: unknown) => ({}));
vi.mock("@/lib/api-client", () => ({
  api: { modelEndpoints: { create: (input: unknown) => create(input) } },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AllModels, ModelPicker } from "./model-picker";

const MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "gpt-4o"];
const PRICES = {
  unit: "credits" as const,
  byModel: { "claude-haiku-4-5": 1, "claude-sonnet-5": 2, "claude-opus-5": 6, "gpt-4o": 3 },
};
const ENDPOINT: ModelEndpoint = {
  id: "e1",
  modelId: "endpoint:e1",
  label: "Our proxy",
  model: "gpt-5-mini",
  host: "proxy.acme.test",
  createdBy: "u1",
  createdAt: 0,
};

function wrap(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("ModelPicker", () => {
  it("offers the three tiers with their ids and prices, and a specific model", async () => {
    const onChange = vi.fn();
    wrap(
      <ModelPicker
        value="claude-sonnet-5"
        onChange={onChange}
        models={MODELS}
        prices={PRICES}
        endpoints={[]}
      />,
    );
    expect(screen.getByRole("radio", { name: /Standard.*claude-sonnet-5/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/~6 credits per message/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /Best/ }));
    expect(onChange).toHaveBeenCalledWith("claude-opus-5");
  });

  it("pins an id no tier stands for, with the list of every id", () => {
    wrap(
      <ModelPicker
        value="gpt-4o"
        onChange={vi.fn()}
        models={MODELS}
        prices={PRICES}
        endpoints={[]}
      />,
    );
    expect(screen.getByRole("radio", { name: /A specific model/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Specific model" })).toHaveTextContent("gpt-4o");
  });

  it("is the one list on an install that serves no tier", () => {
    wrap(
      <ModelPicker
        value="gpt-4o"
        onChange={vi.fn()}
        models={["gpt-4o", "gpt-5-mini"]}
        prices={undefined}
        endpoints={[]}
      />,
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Specific model" })).toBeInTheDocument();
  });
});

describe("AllModels", () => {
  it("lists every id with its tier and price, the selected one, and endpoints with no price", () => {
    wrap(
      <AllModels
        models={MODELS}
        prices={PRICES}
        endpoints={[ENDPOINT]}
        value="gpt-4o"
        canAdd={false}
      />,
    );
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
    expect(screen.getByText("via proxy.acme.test")).toBeInTheDocument();
    expect(screen.getByText("no price")).toBeInTheDocument();
    expect(screen.queryByText(/add a custom endpoint/i)).not.toBeInTheDocument();
  });

  it("lets an admin add an endpoint, https only", async () => {
    wrap(<AllModels models={MODELS} prices={PRICES} endpoints={[]} value="gpt-4o" canAdd />);
    await userEvent.click(screen.getByRole("button", { name: /add a custom endpoint/i }));
    await userEvent.type(screen.getByLabelText("Name"), "Our proxy");
    await userEvent.type(screen.getByLabelText("Model"), "gpt-5-mini");
    await userEvent.type(screen.getByLabelText("Base URL"), "http://insecure.test");
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://proxy.acme.test/v1");
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(create).toHaveBeenCalledWith({
      label: "Our proxy",
      model: "gpt-5-mini",
      baseUrl: "https://proxy.acme.test/v1",
    });
  });
});
