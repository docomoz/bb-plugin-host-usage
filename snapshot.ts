import { z } from "zod";

const amount = z.number().finite().nonnegative();
const label = z.string().trim().min(1).max(160);
const usageSchema = z.object({ used: amount, limit: amount.positive().nullable() });
const spaceSchema = z.object({ total: amount.positive(), available: amount })
  .refine(({ total, available }) => available <= total);

export const workloadSchema = z.object({
  id: label,
  /** Stable identity for user-chosen names: survives container re-creation. Older collectors omit it. */
  key: label.optional(),
  name: label,
  bb: z.boolean(),
  runtime: z.enum(["docker", "podman", "process"]),
  state: z.enum(["running", "healthy", "unhealthy", "starting", "paused", "stopped", "unknown"]),
  ram: usageSchema.nullable(),
  cpu: usageSchema.nullable(),
  tmp: spaceSchema.nullable(),
  tmpShared: z.boolean(),
  oomKills: amount.int().nullable(),
  restarts: amount.int().nullable(),
});

export const snapshotSchema = z.object({
  version: z.literal(1),
  measuredAt: amount.int().max(8.64e15),
  periodSeconds: amount.int().min(5).max(3600).nullable(),
  host: z.object({
    name: label,
    /** Logical CPUs on the host. Older collectors omit it. */
    cpus: amount.int().positive().max(4096).optional(),
    ram: spaceSchema.nullable(),
    cpuPercent: amount.max(100).nullable(),
    swap: spaceSchema.nullable(),
    disk: spaceSchema.nullable(),
    tmp: spaceSchema.nullable(),
    tmpShared: z.boolean(),
  }).nullable(),
  workloads: z.array(workloadSchema).max(500),
  problems: z.array(z.enum(["docker", "podman", "inventory", "cgroups", "processes"])).max(5),
});

export const HOST_KEY = "host";
export const aliasKeySchema = z.string().trim().min(1).max(200);
export const aliasNameSchema = z.string().trim().max(80);
export const aliasesSchema = z.record(aliasKeySchema, aliasNameSchema.min(1));

export const replySchema = z.object({
  mode: z.enum(["local", "collector"]),
  status: z.enum(["fresh", "stale", "missing", "unreadable", "invalid"]),
  snapshot: snapshotSchema.nullable(),
  /** The workload this BB server runs in, when it can be recognized. */
  selfId: z.string().nullable(),
  /** User-chosen display names for this BB installation, by `HOST_KEY` or `workloadKey`. */
  aliases: aliasesSchema,
});

export type Workload = z.infer<typeof workloadSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Reply = z.infer<typeof replySchema>;
export type Space = z.infer<typeof spaceSchema>;
export type Aliases = z.infer<typeof aliasesSchema>;

export function workloadKey(row: Workload) {
  return row.key ?? (row.runtime === "process" ? row.id : `${row.runtime}:${row.name}`);
}

export function freshness(snapshot: Snapshot, now = Date.now()): "fresh" | "stale" | "invalid" {
  const age = now - snapshot.measuredAt;
  if (age < -30_000) return "invalid";
  return age > Math.max(90, (snapshot.periodSeconds ?? 30) * 3) * 1000 ? "stale" : "fresh";
}

/**
 * Finds the workload that hosts this BB server. `containerIds` come from the
 * server's own mount table, `hostname` covers Docker's default short-id host
 * name, and `pid` matches a native process on the same PID namespace.
 */
export function findSelf(
  workloads: readonly Workload[],
  { containerIds, hostname, pid }: { containerIds: readonly string[]; hostname: string; pid: number },
): string | null {
  const shortId = /^[0-9a-f]{12}$/u.test(hostname) ? hostname : null;
  const match = workloads.find((row) => {
    const [runtime, id = "", ...rest] = row.id.split(":");
    if (runtime === "process") return id === String(pid) && rest.length > 0;
    return containerIds.includes(id) || (shortId !== null && id.startsWith(shortId));
  });
  return match?.id ?? null;
}
