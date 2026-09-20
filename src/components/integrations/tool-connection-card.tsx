import { useState } from "react";
import { toast } from "sonner";
import { Database, Globe, Plus, Trash2 } from "lucide-react";
import type { ToolConnection } from "@/lib/connections-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Chip, SectionCard } from "@/components/section-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateToolConnection, useRemoveToolConnection } from "@/hooks/use-connections";

/**
 * A service an agent can call, and the form that adds one.
 *
 * The form is short on purpose, and the shortness is the feature rather than
 * an omission: everything a new service needs is on it, because the worker
 * has no per-service code to go with it. Somebody adding HubSpot fills this
 * in; nobody ships a release.
 *
 * Read `DESIGN.md` before changing any of this. What it constrains here: the
 * 44px tile is the accent ceiling and holds a neutral mark, the chips are
 * neutral (a chip never carries the destructive tone), and the radius ladder
 * runs 4 chip · 8 button · 10 row · 12 card — a child is never tighter than
 * its parent.
 */

/** Methods a person can allow. Write verbs are offered and default to off. */
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export function ToolConnectionCard({ connection }: { connection: ToolConnection }) {
  const remove = useRemoveToolConnection();
  const [confirming, setConfirming] = useState(false);
  const Mark = connection.transport === "sql" ? Database : Globe;
  // Anything past GET and HEAD changes something at the other end, which is
  // the one fact about a connection worth putting on the row. Said in words
  // rather than in colour: a chip stays neutral-or-amber, and amber here
  // would be five pointers on a page that should have one.
  const writes = connection.allowedMethods.some((m) => !["GET", "HEAD"].includes(m));

  return (
    <SectionCard className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
            <Mark className="h-[22px] w-[22px]" />
          </span>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight [overflow-wrap:anywhere]">
              {connection.label}
            </span>
            <span className="text-meta leading-tight text-muted-foreground [overflow-wrap:anywhere]">
              {connection.baseUrl}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Chip tone="neutral">{connection.transport === "sql" ? "Database" : "HTTP API"}</Chip>
          {writes ? <Chip tone="neutral">Can write</Chip> : <Chip tone="neutral">Read only</Chip>}
        </div>
      </div>

      <p className="text-meta leading-[1.45] text-muted-foreground">
        {connection.transport === "sql" ? (
          <>
            Reached through{" "}
            <span className="font-mono text-xs">{connection.rpc ?? "covan_query"}</span>. Whether it
            can write is decided by that function, not by this page.
          </>
        ) : (
          <>Allowed methods: {connection.allowedMethods.join(", ") || "none"}.</>
        )}
      </p>

      {connection.summary ? (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-surface px-3 py-2 text-meta leading-[1.45] text-muted-foreground">
          {connection.summary}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-meta text-muted-foreground">
              Remove it? Agents lose this service immediately.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                remove.mutate(connection.id, {
                  onSuccess: () => toast.success(`${connection.label} removed.`),
                  onError: (err) =>
                    toast.error(err instanceof Error ? err.message : "Could not remove that"),
                })
              }
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Remove
          </Button>
        )}
      </div>
    </SectionCard>
  );
}

/** One header a service wants, as a person enters it. */
type HeaderRow = { name: string; value: string };

export function AddToolConnectionCard() {
  const create = useCreateToolConnection();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<"http" | "sql">("sql");
  const [baseUrl, setBaseUrl] = useState("");
  const [rpc, setRpc] = useState("covan_query");
  const [summary, setSummary] = useState("");
  const [methods, setMethods] = useState<string[]>(["GET"]);
  // Two rows to begin with, because the first service most people connect is
  // a Supabase behind Kong and that one wants two headers. One row would make
  // the commonest case look like the unusual one.
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { name: "Authorization", value: "" },
    { name: "", value: "" },
  ]);

  const reset = () => {
    setLabel("");
    setBaseUrl("");
    setRpc("covan_query");
    setSummary("");
    setMethods(["GET"]);
    setHeaders([
      { name: "Authorization", value: "" },
      { name: "", value: "" },
    ]);
    setOpen(false);
  };

  const filled = headers.filter((h) => h.name.trim() && h.value.trim());
  const ready = label.trim() && baseUrl.trim() && filled.length > 0;

  if (!open) {
    return (
      <SectionCard className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="font-dm text-title font-medium leading-tight">Connect a service</span>
          <span className="text-meta leading-tight text-muted-foreground">
            A database or an API an agent can query while it answers. No code — a row.
          </span>
        </span>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add
        </Button>
      </SectionCard>
    );
  }

  return (
    <SectionCard className="flex flex-col gap-5">
      <span className="font-dm text-title font-medium leading-tight">Connect a service</span>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-label">Name</Label>
          <Input
            id="tc-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Covan Supabase"
          />
          <p className="text-xs text-muted-foreground">
            What the agent calls it. Anything you would say out loud.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-transport">Kind</Label>
          <Select value={transport} onValueChange={(v) => setTransport(v as "http" | "sql")}>
            <SelectTrigger id="tc-transport" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sql">Postgres behind PostgREST</SelectItem>
              <SelectItem value="http">HTTP API</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tc-url">Base address</Label>
        <Input
          id="tc-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={
            transport === "sql" ? "https://xyz.supabase.co/rest/v1" : "https://api.example.com/v1"
          }
        />
        <p className="text-xs leading-[1.45] text-muted-foreground">
          Every request stays inside this address. The agent names a path, never a URL, so it cannot
          reach anywhere else.
          {transport === "sql"
            ? " For hosted Supabase that is the project URL with /rest/v1 on the end."
            : null}
        </p>
      </div>

      {transport === "sql" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-rpc">Read-only function</Label>
          <Input id="tc-rpc" value={rpc} onChange={(e) => setRpc(e.target.value)} />
          <p className="text-xs leading-[1.45] text-muted-foreground">
            The function the agent's SQL runs inside. It is what makes the connection read-only —
            the method is a POST either way, and the function is what refuses a write. The SQL to
            install it is in the integrations guide.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label>Methods you allow</Label>
          <div className="flex flex-wrap gap-1.5">
            {METHODS.map((method) => {
              const on = methods.includes(method);
              return (
                <button
                  key={method}
                  type="button"
                  onClick={() =>
                    setMethods((current) =>
                      on ? current.filter((m) => m !== method) : [...current, method],
                    )
                  }
                  className={`rounded-[4px] border px-2 py-1 text-xs transition-colors ${
                    on
                      ? "border-foreground bg-foreground text-background"
                      : "border-hairline text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {method}
                </button>
              );
            })}
          </div>
          <p className="text-xs leading-[1.45] text-muted-foreground">
            This is your decision, not the agent's — it cannot widen the list. Leaving it at GET
            means nothing it does here can change anything.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label>Credential headers</Label>
        {headers.map((header, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Input
              value={header.name}
              onChange={(e) =>
                setHeaders((rows) =>
                  rows.map((r, j) => (i === j ? { ...r, name: e.target.value } : r)),
                )
              }
              placeholder="Header name"
            />
            <Input
              type="password"
              value={header.value}
              onChange={(e) =>
                setHeaders((rows) =>
                  rows.map((r, j) => (i === j ? { ...r, value: e.target.value } : r)),
                )
              }
              placeholder="Value"
            />
          </div>
        ))}
        <button
          type="button"
          className="self-start text-meta text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={() => setHeaders((rows) => [...rows, { name: "", value: "" }])}
        >
          Another header
        </button>
        <p className="text-xs leading-[1.45] text-muted-foreground">
          Encrypted before it reaches the database and never sent back to this screen. A token that
          needs the word "Bearer" in front of it is stored with the word in front of it. Supabase
          wants two: <span className="font-mono text-xs">Authorization</span> with{" "}
          <span className="font-mono text-xs">Bearer …</span> and{" "}
          <span className="font-mono text-xs">apikey</span> with the key on its own.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tc-summary">What it holds {transport === "sql" ? "(optional)" : ""}</Label>
        <Textarea
          id="tc-summary"
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={
            transport === "sql"
              ? "Left empty, the agent reads the schema itself the first time it asks."
              : "Which paths exist and what they return. The agent has no other way to know."
          }
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          disabled={!ready || create.isPending}
          onClick={() =>
            create.mutate(
              {
                label: label.trim(),
                transport,
                baseUrl: baseUrl.trim(),
                headers: Object.fromEntries(filled.map((h) => [h.name.trim(), h.value])),
                ...(transport === "http" ? { allowedMethods: methods } : {}),
                ...(transport === "sql" ? { rpc: rpc.trim() } : {}),
                ...(summary.trim() ? { summary: summary.trim() } : {}),
              },
              {
                onSuccess: () => {
                  toast.success(`${label.trim()} connected.`);
                  reset();
                },
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : "Could not connect that"),
              },
            )
          }
        >
          {create.isPending ? "Connecting…" : "Connect"}
        </Button>
        <Button variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>
    </SectionCard>
  );
}
