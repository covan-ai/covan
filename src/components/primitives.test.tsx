import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusDot, StatusWord } from "./status-dot";
import { Tile } from "./tile";
import { getInitials, monogram } from "@/lib/monogram";
import { Avatar } from "./avatar";
import { DataTable, Pagination } from "./data-table";
import { Pills } from "./pills";
import { Segmented } from "./segmented";
import { KeyValue } from "./kv";
import { Field } from "./field";
import { EmptyPage } from "./empty-page";

describe("the dot", () => {
  it("is silent beside its word, and speaks when it stands alone", () => {
    const { container } = render(<StatusWord state="waiting" />);
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(container.querySelector("[aria-hidden]")).toHaveClass("border-brand");
    render(<StatusDot state="running" label="Research is running" />);
    expect(screen.getByRole("img", { name: "Research is running" })).toHaveClass("dot-live");
  });
});

describe("identity", () => {
  it("draws a workspace's monogram and a person's initials", () => {
    expect(monogram("Google Drive")).toBe("GD");
    expect(monogram("Acme", 16)).toBe("A");
    expect(getInitials("Mina Kaya")).toBe("MK");
    render(<Tile label="Acme" tone="ink" />);
    render(<Avatar name="Mina Kaya" />);
    expect(screen.getByText("MK")).toHaveClass("rounded-full");
  });
});

describe("a table", () => {
  const rows = [
    { id: "a", name: "Refund policy", size: 120 },
    { id: "b", name: "Shipping SLA", size: 64 },
  ];
  it("opens a row on a click or Enter, and says how much it shows", () => {
    const open = vi.fn();
    render(
      <DataTable
        label="Files"
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={open}
        columns={[
          { key: "name", header: "Name", cell: (r) => r.name },
          { key: "size", header: "Size", cell: (r) => `${r.size} KB`, num: true },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Refund policy"));
    fireEvent.keyDown(screen.getByText("Shipping SLA").closest("tr")!, { key: "Enter" });
    expect(open.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["a", "b"]);
    expect(screen.getByText("120 KB")).toHaveClass("text-right");

    const onPage = vi.fn();
    render(<Pagination shown={13} total={312} page={1} pageCount={24} onPage={onPage} />);
    expect(screen.getByText("Showing 13 of 312")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
});

describe("choosing", () => {
  it("presses one pill and checks one segment", () => {
    const pick = vi.fn();
    render(
      <Pills
        label="Show"
        value="all"
        onChange={pick}
        options={[
          { value: "all", label: "All" },
          { value: "unread", label: "Unread", count: 3 },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Unread/ }));
    expect(pick).toHaveBeenCalledWith("unread");

    render(
      <Segmented
        label="Theme"
        value="dark"
        onChange={() => {}}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />,
    );
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("page grammar", () => {
  it("lays out a field, key-value rows and an empty page", () => {
    render(
      <>
        <Field label="Workspace name" help="Shown to everyone in it." htmlFor="ws">
          <input id="ws" />
        </Field>
        <KeyValue rows={[{ k: "Cron", v: "0 9 * * 1" }]} />
        <EmptyPage title="Nothing needs you" dot="done" />
      </>,
    );
    expect(screen.getByLabelText("Workspace name")).toBeInTheDocument();
    expect(screen.getByText("Cron").tagName).toBe("DT");
    expect(screen.getByRole("heading", { name: "Nothing needs you" })).toBeInTheDocument();
  });
});
