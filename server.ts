import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { sampleLocal } from "./local";
import {
  aliasesSchema, aliasKeySchema, aliasNameSchema, findSelf, freshness, replySchema, snapshotSchema,
  type Aliases, type Reply, type Snapshot,
} from "./snapshot";

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: replySchema },
  rename: {
    input: z.object({ key: aliasKeySchema, name: aliasNameSchema }).strict(),
    output: aliasesSchema,
  },
});

type Collected = Pick<Reply, "mode" | "status" | "snapshot">;

const snapshotBytes = 1024 * 1024;
const maxAliases = 500;
const aliasesKey = "aliases";

async function readSnapshot(path: string): Promise<Collected> {
  try {
    if (!(await lstat(path)).isFile()) return { mode: "collector", status: "invalid", snapshot: null };
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > snapshotBytes) {
        return { mode: "collector", status: "invalid", snapshot: null };
      }
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) return { mode: "collector", status: "invalid", snapshot: null };
      const parsed = snapshotSchema.safeParse(JSON.parse(buffer.toString("utf8", 0, offset)));
      if (!parsed.success) return { mode: "collector", status: "invalid", snapshot: null };
      const status = freshness(parsed.data);
      return { mode: "collector", status, snapshot: status === "invalid" ? null : parsed.data };
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status = code === "ENOENT" ? "missing"
      : error instanceof SyntaxError || code === "ELOOP" ? "invalid" : "unreadable";
    return { mode: "collector", status, snapshot: null };
  }
}

/** Container ids that appear in this process's own mounts (Docker and Podman bind hostname/resolv.conf). */
async function ownContainerIds() {
  const mounts = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  return [...new Set([...mounts.matchAll(/containers\/([0-9a-f]{64})\//gu)].map(([, id]) => id))];
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    snapshotPath: {
      type: "string",
      label: "Collector snapshot path",
      description: "Absolute path to the JSON file on the BB server. Leave blank to use the default path or local metrics.",
      experimental_schema: z.string().max(4096).refine(
        (value) => value === "" || (isAbsolute(value) && !value.includes("\0")),
        "Enter an absolute path or leave this field empty.",
      ),
      default: "",
    },
  });

  async function loadAliases(): Promise<Aliases> {
    const parsed = aliasesSchema.safeParse(await bb.storage.kv.get(aliasesKey).catch(() => undefined));
    return parsed.success ? parsed.data : {};
  }

  let writing: Promise<unknown> = Promise.resolve();
  const containerIds = ownContainerIds();
  let local: Snapshot | undefined;
  let pending: Promise<Snapshot> | undefined;

  bb.rpc.register(rpcContract, {
    async snapshot(): Promise<Reply> {
      const { snapshotPath } = await settings.get();
      let reply: Collected = await readSnapshot(snapshotPath || join(homedir(), ".local", "share", "bb-host-usage", "latest.json"));
      if (!snapshotPath && reply.status === "missing") {
        if (!local || Date.now() - local.measuredAt > 5_000) {
          pending ??= sampleLocal().then((snapshot) => (local = snapshot)).finally(() => { pending = undefined; });
          local = await pending;
        }
        reply = { mode: "local", status: "fresh", snapshot: local ?? null };
      }
      const selfId = reply.mode === "local"
        ? reply.snapshot?.workloads[0]?.id ?? null
        : reply.snapshot
          ? findSelf(reply.snapshot.workloads, { containerIds: await containerIds, hostname: hostname(), pid: process.pid })
          : null;
      return { ...reply, selfId, aliases: await loadAliases() };
    },

    async rename({ key, name }) {
      // Serialize read-modify-write so two quick renames cannot drop each other.
      const next = writing.then(async () => {
        const aliases = await loadAliases();
        if (name) aliases[key] = name;
        else delete aliases[key];
        const entries = Object.entries(aliases);
        const bounded = Object.fromEntries(entries.slice(Math.max(0, entries.length - maxAliases)));
        await bb.storage.kv.set(aliasesKey, bounded);
        return bounded;
      });
      writing = next.catch(() => undefined);
      return next;
    },
  });
}
