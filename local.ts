import { readFile, stat, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, hostname, tmpdir, totalmem } from "node:os";
import { parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Snapshot, Space } from "./snapshot";

async function filesystem(path: string): Promise<Space | null> {
  try {
    const { blocks, bavail, bsize } = await statfs(path);
    return blocks > 0
      ? { total: blocks * bsize, available: Math.min(blocks, Math.max(0, bavail)) * bsize }
      : null;
  } catch {
    return null;
  }
}

async function sameFilesystem(left: string, right: string) {
  if (process.platform === "win32") return parse(left).root.toLowerCase() === parse(right).root.toLowerCase();
  try {
    const [a, b] = await Promise.all([stat(left), stat(right)]);
    return a.dev === b.dev;
  } catch {
    return false;
  }
}

function cpuTicks() {
  return cpus().reduce(({ idle, total }, { times }) => ({
    idle: idle + times.idle,
    total: total + times.user + times.nice + times.sys + times.idle + times.irq,
  }), { idle: 0, total: 0 });
}

async function inContainer() {
  if (process.platform !== "linux") return false;
  if (process.env.container) return true;
  const markers = await Promise.allSettled([stat("/.dockerenv"), stat("/run/.containerenv")]);
  if (markers.some((result) => result.status === "fulfilled")) return true;
  const cgroup = await readFile("/proc/1/cgroup", "utf8").catch(() => "");
  return /(?:docker|libpod|lxc|kubepods)[-/]/u.test(cgroup);
}

async function linuxMemory() {
  if (process.platform !== "linux") return { available: freemem(), swap: null };
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const info = Object.fromEntries([...meminfo.matchAll(/^(MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm)]
    .map(([, key, value]) => [key, Number(value) * 1024]));
  return {
    available: info.MemAvailable ?? freemem(),
    swap: info.SwapTotal > 0 && info.SwapFree !== undefined
      ? { total: info.SwapTotal, available: Math.min(info.SwapTotal, info.SwapFree) }
      : null,
  };
}

export async function sampleLocal(): Promise<Snapshot> {
  const root = parse(homedir()).root;
  const temp = process.platform === "win32" ? tmpdir() : "/tmp";
  const isolated = await inContainer();
  const start = performance.now();
  const usage = process.cpuUsage();
  const ticks = cpuTicks();
  const [tmp, tmpShared, disk, memory] = await Promise.all([
    filesystem(temp),
    sameFilesystem(root, temp),
    isolated ? null : filesystem(root),
    isolated ? null : linuxMemory(),
    delay(300),
  ]);
  const delta = process.cpuUsage(usage);
  const current = cpuTicks();
  const total = current.total - ticks.total;
  const ram = totalmem();
  return {
    version: 1,
    measuredAt: Date.now(),
    periodSeconds: null,
    host: memory ? {
      name: hostname().slice(0, 160),
      cpus: cpus().length || undefined,
      ram: ram > 0 ? { total: ram, available: Math.min(ram, memory.available) } : null,
      cpuPercent: total > 0 ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - ticks.idle) / total))) : null,
      swap: memory.swap,
      disk,
      tmp,
      tmpShared,
    } : null,
    workloads: [{
      id: "local-bb",
      key: "process:local",
      name: "BB",
      bb: true,
      runtime: "process",
      state: "running",
      ram: { used: process.memoryUsage().rss, limit: null },
      cpu: { used: (delta.user + delta.system) / ((performance.now() - start) * 1000), limit: null },
      tmp,
      tmpShared,
      oomKills: null,
      restarts: null,
    }],
    problems: [],
  };
}
