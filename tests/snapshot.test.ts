import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleLocal } from "../local.ts";
import { freshness, snapshotSchema, type Snapshot } from "../snapshot.ts";

const measuredAt = 1_795_495_230_000;
const snapshot: Snapshot = {
  version: 1, measuredAt, periodSeconds: 30, host: null, workloads: [], problems: [],
};

test("separates fresh, stale, and future snapshots", () => {
  assert.equal(freshness(snapshot, measuredAt + 90_000), "fresh");
  assert.equal(freshness(snapshot, measuredAt + 90_001), "stale");
  assert.equal(freshness(snapshot, measuredAt - 31_000), "invalid");
  assert.equal(freshness({ ...snapshot, periodSeconds: 300 }, measuredAt + 600_000), "fresh");
});

test("validates the source format and keeps zero capacity available", () => {
  const host = {
    name: "Server", disk: { total: 100, available: 0 }, ram: null, swap: null, tmp: null,
    cpuPercent: 0, tmpShared: false,
  };
  assert.equal(snapshotSchema.parse({ ...snapshot, host }).host?.disk?.available, 0);
  assert.equal(snapshotSchema.safeParse({ ...snapshot, version: 2 }).success, false);
  assert.equal(snapshotSchema.safeParse({ ...snapshot, host: { ...host, disk: { total: 100, available: 101 } } }).success, false);
});

test("the built-in sampler supplies data without a host collector", async () => {
  const local = snapshotSchema.parse(await sampleLocal());
  assert.equal(local.periodSeconds, null);
  assert.equal(local.workloads.length, 1);
  assert.equal(local.workloads[0].runtime, "process");
  assert.ok(local.workloads[0].ram!.used > 0);
});

test("recognizes this BB by container id, Docker short host name, or native PID", async () => {
  const { findSelf, workloadKey } = await import("../snapshot.ts");
  const id = "48e38efc690441d49718e73d441e6b4165b5ecd427406638e0411263abc90e4d";
  const row = (overrides: Partial<Snapshot["workloads"][number]>) => ({
    id: `docker:${id}`, name: "bb-1", bb: true, runtime: "docker" as const, state: "healthy" as const,
    ram: null, cpu: null, tmp: null, tmpShared: false, oomKills: null, restarts: null, ...overrides,
  });
  const rows = [row({ id: "docker:" + "0".repeat(64) }), row({})];
  assert.equal(findSelf(rows, { containerIds: [id], hostname: "custom", pid: 1 }), `docker:${id}`);
  assert.equal(findSelf(rows, { containerIds: [], hostname: id.slice(0, 12), pid: 1 }), `docker:${id}`);
  assert.equal(findSelf(rows, { containerIds: [], hostname: "custom", pid: 1 }), null);
  assert.equal(findSelf([row({ id: "process:4242:99", runtime: "process" })], { containerIds: [], hostname: "x", pid: 4242 }), "process:4242:99");
  // Names stay attached across container re-creation; older snapshots fall back to runtime and name.
  assert.equal(workloadKey(row({ key: "docker:bb-1" })), "docker:bb-1");
  assert.equal(workloadKey(row({})), "docker:bb-1");
});
