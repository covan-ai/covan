import { lookup, type Translate } from "@/i18n";
import { api } from "@/lib/api-client";
import { KIND_NAME, type ArrivalBucket, type ArrivalKind, type ArrivalScan } from "@/lib/arrivals";
import { arrivalTemplateById, fillTemplate } from "@/lib/routine-templates";

/** The worker's mask for an email channel's label (`maskSecret`), to find one already made. */
function maskedEmail(address: string): string {
  const [local, domain] = address.split("@");
  const shown = local.length <= 2 ? local : `${local[0]}…${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

export function bucketName(t: Translate, bucket: ArrivalBucket): string {
  return bucket.label || lookup(t, KIND_NAME[bucket.kind]);
}

/**
 * Makes one routine per picked proposal, in the report's order.
 *
 * Every digest goes to the Covan inbox and to the person's own address (the
 * owner's decision, spec "Proposals"): the first routine is created with the
 * address, which makes the channel — or with a confirmed channel the person
 * already has at that address — and every later one reuses that channel, so
 * one press makes one channel at most. Each routine is written back to its
 * bucket as soon as it exists, and a bucket that has one is skipped, so a
 * second press, or a press after a half-way failure, makes nothing twice.
 */
export async function turnOn(input: {
  scan: ArrivalScan;
  picked: ArrivalKind[];
  agentId: string;
  email: string;
  timezone: string;
  t: Translate;
}): Promise<{ created: number; failed: boolean }> {
  const { scan, picked, agentId, email, timezone, t } = input;
  const todo = scan.buckets.filter((b) => picked.includes(b.kind) && b.templateId && !b.routineId);
  if (todo.length === 0) return { created: 0, failed: false };

  let created = 0;
  try {
    const channels = await api.deliveryChannels.list().catch(() => []);
    let channelId = channels.find(
      (c) => c.kind === "email" && c.confirmed && c.label === maskedEmail(email),
    )?.id;
    for (const bucket of todo) {
      const template = arrivalTemplateById(bucket.templateId!);
      if (!template) continue;
      const draft = fillTemplate(template, bucketName(t, bucket));
      const routine = await api.routines.create({
        agentId,
        name: lookup(t, draft.name),
        sourceKind: "none",
        instruction: draft.instruction,
        scheduleCron: draft.scheduleCron,
        timezone,
        deliverInbox: true,
        ...(channelId ? { deliveryChannelId: channelId } : { deliveryEmail: email }),
      });
      channelId = routine.deliveryChannelId;
      await api.arrivals.setRoutine(scan.id, bucket.kind, routine.id);
      created += 1;
    }
    return { created, failed: false };
  } catch {
    return { created, failed: true };
  }
}
