import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Chip } from "@/components/chip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError, type ModelEndpoint } from "@/lib/api-client";
import { formatReplyPrice, modelTiers, priceFor, tierOf, type ReplyPrices } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";

/** "~2 credits per message", or nothing for a model with no price. */
function perMessage(prices: ReplyPrices | undefined, model: string): string {
  const price = priceFor(prices, model);
  return price ? `${formatReplyPrice(price)} per message` : "";
}

/** An endpoint's model id as the list names it: "Acme proxy · gpt-5-mini". */
function endpointName(e: ModelEndpoint): string {
  return `${e.label} · ${e.model}`;
}

/**
 * The default model (A10): Fast, Standard and Best as option rows with the id
 * and the price each, and a fourth row, "A specific model", pinned to one id —
 * every id this install serves, and the workspace's own endpoints.
 *
 * On an install that serves none of the tier models (self-hosted, OpenAI
 * only) there is nothing for the three rows to stand for, and the picker is
 * the one Select.
 */
export function ModelPicker({
  value,
  onChange,
  models,
  prices,
  endpoints,
  disabled,
}: {
  value: string;
  onChange: (model: string) => void;
  /** What the list offers — `modelsFor(me.models, value)`. */
  models: string[];
  prices: ReplyPrices | undefined;
  endpoints: ModelEndpoint[];
  disabled?: boolean;
}) {
  const tiers = modelTiers(models);
  const [pinning, setPinning] = useState(false);
  const pinned = pinning || tierOf(value) === null;

  const specific = (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label="Specific model" className="max-w-[360px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
            {perMessage(prices, m) ? ` · ${perMessage(prices, m)}` : ""}
          </SelectItem>
        ))}
        {endpoints.map((e) => (
          <SelectItem key={e.modelId} value={e.modelId}>
            {endpointName(e)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (tiers.length === 0) return specific;

  return (
    <div role="radiogroup" aria-label="Default model" className="flex flex-col gap-2">
      {tiers.map((t) => (
        <OptionRow
          key={t.id}
          checked={!pinned && t.model === value}
          disabled={disabled}
          onSelect={() => {
            setPinning(false);
            onChange(t.model);
          }}
          title={
            <>
              {t.label}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t.model}</span>
            </>
          }
          description={`${t.description}${perMessage(prices, t.model) ? ` ${perMessage(prices, t.model)}.` : ""}`}
        />
      ))}
      <OptionRow
        checked={pinned}
        disabled={disabled}
        onSelect={() => setPinning(true)}
        title="A specific model"
        description="Pinned to one id. Shows as Custom to the team, priced at that model's rate."
      >
        {pinned ? <div className="mt-2.5">{specific}</div> : null}
      </OptionRow>
    </div>
  );
}

function OptionRow({
  checked,
  disabled,
  onSelect,
  title,
  description,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5",
        checked ? "border-foreground" : "border-border",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full min-w-0 items-start gap-3 text-left disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
            checked ? "border-foreground" : "border-dot-done",
          )}
        >
          {checked ? <span className="size-2 rounded-full bg-foreground" /> : null}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-meta text-muted-foreground">{description}</span>
        </span>
      </button>
      {children ? <div className="pl-7">{children}</div> : null}
    </div>
  );
}

/**
 * "All models" (A10): every id this install serves, with its tier, which one
 * is selected and what a message costs; the workspace's endpoints, "via" their
 * host and with no price; and, for an admin, "Add a custom endpoint".
 */
export function AllModels({
  models,
  prices,
  endpoints,
  value,
  canAdd,
}: {
  models: string[];
  prices: ReplyPrices | undefined;
  endpoints: ModelEndpoint[];
  value: string;
  canAdd: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const row = "flex min-h-11 items-center gap-2.5 border-b border-hairline px-3";
  const selectedChip = (
    <Chip size="sm" tone="ink">
      Selected
    </Chip>
  );

  return (
    <div className="max-w-[560px] overflow-hidden rounded-lg border border-border [&>*:last-child]:border-b-0">
      {models.map((m) => {
        const selected = m === value;
        const tier = tierOf(m);
        const price = priceFor(prices, m);
        return (
          <div key={m} className={cn(row, selected && "bg-surface-muted")}>
            <Chip tone="code">{m}</Chip>
            <span className="flex-1" />
            {selected ? selectedChip : tier ? <Chip size="sm">{tier.label}</Chip> : null}
            <span className="w-24 text-right text-meta text-muted-foreground tabular-nums">
              {price ? formatReplyPrice(price) : "no price"}
            </span>
          </div>
        );
      })}
      {endpoints.map((e) => {
        const selected = e.modelId === value;
        return (
          <div key={e.id} className={cn(row, selected && "bg-surface-muted")}>
            <Chip tone="code">{e.model}</Chip>
            <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
              via {e.host}
            </span>
            {selected ? selectedChip : <Chip size="sm">Endpoint</Chip>}
            <span className="w-24 text-right text-meta text-muted-foreground">no price</span>
          </div>
        );
      })}
      {canAdd ? (
        <div className="flex min-h-11 items-center px-3">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 text-meta font-medium text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden />
            Add a custom endpoint
          </button>
        </div>
      ) : null}
      <AddEndpointDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

/**
 * A workspace's own OpenAI-compatible endpoint (0135): what it is called, the
 * model's name there, its address, and a key the server seals and never sends
 * back. Agents pick it like any other model.
 */
function AddEndpointDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setLabel("");
      setModel("");
      setBaseUrl("");
      setApiKey("");
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.modelEndpoints.create({
        label: label.trim(),
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["model-endpoints"] });
      toast.success("Endpoint added");
      close(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add that endpoint");
    } finally {
      setSaving(false);
    }
  };

  const ready = label.trim() && model.trim() && baseUrl.trim().startsWith("https://");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add a custom endpoint</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            A self-hosted or OpenAI-compatible model. Every agent here can pick it; it has no price,
            because whoever runs it pays for it.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="endpoint-label">Name</Label>
            <Input
              id="endpoint-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Our proxy"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endpoint-model">Model</Label>
            <Input
              id="endpoint-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-5-mini"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endpoint-url">Base URL</Label>
            <Input
              id="endpoint-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://models.example.com/v1"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endpoint-key">API key</Label>
            <Input
              id="endpoint-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Optional"
            />
            <p className="m-0 text-xs text-muted-foreground">
              Sealed on the server and never shown again.
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!ready || saving}>
            {saving ? "Adding…" : "Add endpoint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
