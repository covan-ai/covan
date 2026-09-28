import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateToolConnection } from "@/hooks/use-connections";

/**
 * The form that adds a database or an API an agent can call.
 *
 * The form is short on purpose, and the shortness is the feature rather than
 * an omission: everything a new service needs is on it, because the worker
 * has no per-service code to go with it. Somebody adding HubSpot fills this
 * in; nobody ships a release.
 *
 * WHY IT IS A DIALOG NOW. It used to be a card on the Integrations page that
 * expanded in place — two hundred lines of form unfolding between two other
 * cards, so the page's height and the position of everything below it changed
 * on a click. Three surfaces on that page did the same thing, and between
 * them they were most of the reason it read as a pile rather than a list.
 * `DriveFolderDialog` was already the precedent for the heavy interaction on
 * that page; this follows it.
 *
 * Read `DESIGN.md` before changing any of this. What it constrains here: the
 * chips are neutral (a chip never carries the destructive tone), and the
 * radius ladder runs 4 chip · 8 button · 10 row · 12 card — a child is never
 * tighter than its parent.
 */

/** Methods a person can allow. Write verbs are offered and default to off. */
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** One header a service wants, as a person enters it. */
type HeaderRow = { name: string; value: string };

export function AddServiceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateToolConnection();
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
    onOpenChange(false);
  };

  const filled = headers.filter((h) => h.name.trim() && h.value.trim());
  const ready = label.trim() && baseUrl.trim() && filled.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : reset())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect a service</DialogTitle>
          <DialogDescription>
            A database or an API an agent can query while it answers. There is no per-service code
            behind this — what you fill in here is the whole of it.
          </DialogDescription>
        </DialogHeader>

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
            Every request stays inside this address. The agent names a path, never a URL, so it
            cannot reach anywhere else.
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
            Encrypted before it reaches the database and never sent back to this screen. A token
            that needs the word "Bearer" in front of it is stored with the word in front of it.
            Supabase wants two: <span className="font-mono text-xs">Authorization</span> with{" "}
            <span className="font-mono text-xs">Bearer …</span> and{" "}
            <span className="font-mono text-xs">apikey</span> with the key on its own.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-summary">
            What it holds {transport === "sql" ? "(optional)" : ""}
          </Label>
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

        <DialogFooter>
          <Button variant="ghost" onClick={reset}>
            Cancel
          </Button>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
