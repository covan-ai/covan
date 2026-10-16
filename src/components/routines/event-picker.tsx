import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EventCatalogEntry, EventChoice, EventField } from "@/lib/routines-api";

/** Apps in the order the catalogue lists them, each once. */
function appsOf(catalog: EventCatalogEntry[]): string[] {
  return [...new Set(catalog.map((e) => e.app))];
}

/**
 * Pick what a routine waits for: the app, what happens in it, and whatever
 * that event can be narrowed by.
 *
 * Three steps rather than one long list, because the list is long — every app
 * has several events — and the question a person is answering is "which app"
 * first. An app that is not connected is still offered, with a way to connect
 * it, rather than hidden from somebody who has not got round to it yet.
 */
export function EventPicker({
  catalog,
  value,
  onChange,
  idPrefix = "routine-event",
}: {
  catalog: EventCatalogEntry[];
  value: EventChoice | null;
  onChange: (choice: EventChoice | null) => void;
  idPrefix?: string;
}) {
  if (catalog.length === 0) {
    // Not an error: the catalogue is what this deployment can listen for, and
    // a self-hosted one may have set up none of it.
    return (
      <p className="text-xs text-muted-foreground">
        This workspace cannot listen for app events yet. Connect an app from Integrations, or start
        the routine on a schedule or a webhook instead.
      </p>
    );
  }

  const entry = value ? catalog.find((e) => e.type === value.type) : undefined;
  const app = entry?.app ?? "";
  const events = catalog.filter((e) => e.app === app);

  const pickApp = (next: string) => {
    const first = catalog.find((e) => e.app === next);
    onChange(first ? { type: first.type, config: {} } : null);
  };
  const pickEvent = (type: string) => onChange({ type, config: {} });
  const setField = (key: string, v: unknown) => {
    if (!value) return;
    const config = { ...value.config };
    if (v === "" || v === undefined) delete config[key];
    else config[key] = v;
    onChange({ ...value, config });
  };

  const basic = entry?.fields.filter((f) => !f.advanced) ?? [];
  const advanced = entry?.fields.filter((f) => f.advanced) ?? [];

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-app`}>App</Label>
        <Select value={app} onValueChange={pickApp}>
          <SelectTrigger id={`${idPrefix}-app`}>
            <SelectValue placeholder="Pick an app" />
          </SelectTrigger>
          <SelectContent>
            {appsOf(catalog).map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {entry && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-type`}>When</Label>
          <Select value={entry.type} onValueChange={pickEvent}>
            <SelectTrigger id={`${idPrefix}-type`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {events.map((e) => (
                <SelectItem key={e.type} value={e.type}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
      )}

      {entry && !entry.connected && (
        // The one thing standing between this choice and a routine that
        // works, said where the choice is made.
        <p className="text-xs text-muted-foreground">
          {entry.app} is not connected yet.{" "}
          <Link to="/integrations" className="text-foreground underline underline-offset-2">
            Connect {entry.app}
          </Link>{" "}
          and come back to finish.
        </p>
      )}

      {entry &&
        entry.connected &&
        basic.map((f) => (
          <FieldInput
            key={f.key}
            id={`${idPrefix}-${f.key}`}
            field={f}
            value={value?.config[f.key]}
            onChange={(v) => setField(f.key, v)}
          />
        ))}

      {entry && entry.connected && advanced.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">More options</summary>
          <div className="mt-3 space-y-3">
            {advanced.map((f) => (
              <FieldInput
                key={f.key}
                id={`${idPrefix}-${f.key}`}
                field={f}
                value={value?.config[f.key]}
                onChange={(v) => setField(f.key, v)}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function FieldInput({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: EventField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = field.optional ? `${field.label} (optional)` : field.label;
  const help = field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null;

  if (field.kind === "boolean") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={value === true}
            onCheckedChange={(v) => onChange(v || undefined)}
          />
          <Label htmlFor={id}>{field.label}</Label>
        </div>
        {help}
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <Select value={typeof value === "string" ? value : ""} onValueChange={onChange}>
          <SelectTrigger id={id}>
            <SelectValue placeholder={field.placeholder ?? "Pick one"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {help}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={field.kind === "number" ? "number" : "text"}
        placeholder={field.placeholder}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (field.kind !== "number") return onChange(raw);
          // Sent as a number, because the schema on the other side is one;
          // an emptied field is no value rather than zero.
          onChange(raw === "" ? undefined : Number(raw));
        }}
      />
      {help}
    </div>
  );
}
