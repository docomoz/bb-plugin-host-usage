import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp, experimental_Icon as Icon, useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { HOST_KEY, workloadKey, type Aliases, type Reply, type Snapshot, type Space, type Workload } from "./snapshot";

const labels = {
    title: "Host", others: "Other containers", used: "used", free: "free", ram: "RAM", cpu: "CPU",
    disk: "Disk", swap: "Swap", refresh: "Refresh", collapse: "Collapse", rename: "Rename",
    renameHint: "Leave empty to restore", thisBb: "this BB", retry: "Retry",
    running: "running", healthy: "healthy", unhealthy: "unhealthy", starting: "starting",
    paused: "paused", stopped: "stopped", unknown: "unknown",
    measured: "Measured", partial: "Some metrics are unavailable.",
    stale: "The last measurement is out of date.", missing: "Waiting for the first measurement from the host collector.",
    unreadable: "The collector file could not be read.", invalid: "The collector file has invalid data.",
    disconnected: "Could not reach the BB server.",
    containerHost: "BB runs in a container. Connect the host collector to see the host and all containers.",
    noInstances: "No BB server processes found.", noMetrics: "No measurements", none: "No other containers",
    oom: "OOM kills", restarts: "restarts",
    detailUsed: (used: string, total: string, free: string) => `${used} of ${total} used · ${free} free`,
    cpuLimit: "container limit", cpuHost: "all host CPUs", sharedTmp: "/tmp is on the same filesystem",
    ownTmp: "separate filesystem", vcpu: "vCPU",
};

const metricGrid = "grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] gap-x-3";
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring";
const iconButton = `flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50 ${focusRing}`;

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function number(value: number, digits: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(value);
}

function bytes(value: number) {
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${number(scaled, unit >= 2 && scaled < 100 ? 1 : 0)} ${units[unit]}`;
}

function percentOf(used: number, total: number | null | undefined) {
  return total ? Math.min(100, Math.max(0, (100 * used) / total)) : null;
}

/** The same thresholds and token colors as Provider Usage. */
function tone(percent: number | null) {
  if (percent === null) return null;
  return percent >= 95 ? "critical" : percent >= 80 ? "warning" : null;
}
const barColor = { critical: "bg-destructive", warning: "bg-warning", normal: "bg-primary" };
const textColor = { critical: "text-destructive", warning: "text-warning", normal: "text-sidebar-foreground" };

const stateDot: Record<Workload["state"], string> = {
  healthy: "bg-success", running: "bg-success", starting: "bg-warning", paused: "bg-warning",
  unhealthy: "bg-destructive", stopped: "bg-muted-foreground", unknown: "bg-muted-foreground",
};

function needsAttention(row: Workload) {
  return row.state === "unhealthy" || (row.oomKills ?? 0) > 0;
}

/* ------------------------------------------------------------------ rows */

type Metric = { label: string; percent: number | null; value: string; detail: string };

function MetricRow({ label, percent, value, detail }: Metric) {
  const [open, setOpen] = useState(false);
  const level = tone(percent) ?? "normal";
  return (
    <button type="button" aria-expanded={open} title={detail} onClick={() => setOpen((current) => !current)}
      className={cn("col-span-full grid grid-cols-subgrid rounded-sm text-left", focusRing)}>
      <span className="col-span-full grid h-5 grid-cols-subgrid items-center text-2xs">
        <span className="max-w-20 truncate text-subtle-foreground">{label}</span>
        <span className="h-1 min-w-0 overflow-hidden rounded-full bg-sidebar-border">
          {percent !== null && (
            <span className={cn("block h-full rounded-full", barColor[level])}
              style={{ width: `${Math.max(2, percent)}%` }} />
          )}
        </span>
        <span className={cn("text-right tabular-nums", percent === null ? "text-subtle-foreground" : textColor[level])}>
          {percent === null ? "—" : `${Math.round(percent)}%`}
        </span>
        <span className="min-w-9 text-right tabular-nums text-subtle-foreground">{value}</span>
      </span>
      {open && <span className="col-span-full pb-1 text-2xs text-subtle-foreground">{detail}</span>}
    </button>
  );
}

function spaceMetric(label: string, space: Space | null, note?: string): Metric | null {
  if (!space) return null;
  const used = space.total - space.available;
  const detail = labels.detailUsed(bytes(used), bytes(space.total), bytes(space.available));
  return {
    label, percent: percentOf(used, space.total), value: bytes(space.available),
    detail: note ? `${detail} · ${note}` : detail,
  };
}

function cpuMetric(used: number, capacity: number | null, note: string): Metric {
  const usedText = `${number(used, 2)} ${labels.vcpu}`;
  if (!capacity) return { label: labels.cpu, percent: null, value: usedText, detail: usedText };
  const free = Math.max(0, capacity - used);
  return {
    label: labels.cpu,
    percent: percentOf(used, capacity),
    value: `${number(free, free < 10 ? 1 : 0)} ${labels.vcpu}`,
    detail: `${labels.detailUsed(usedText, `${number(capacity, 2)} ${labels.vcpu}`, `${number(free, 2)} ${labels.vcpu}`)} · ${note}`,
  };
}

function hostMetrics(host: NonNullable<Snapshot["host"]>): Metric[] {
  const cpu: Metric = host.cpuPercent === null
    ? { label: labels.cpu, percent: null, value: "—", detail: labels.noMetrics }
    : host.cpus
      ? cpuMetric((host.cpus * host.cpuPercent) / 100, host.cpus, labels.cpuHost)
      : { label: labels.cpu, percent: host.cpuPercent, value: "", detail: `${number(host.cpuPercent, 1)}%` };
  return [
    spaceMetric(labels.ram, host.ram),
    cpu,
    spaceMetric(labels.disk, host.disk, host.tmpShared ? labels.sharedTmp : undefined),
    host.tmpShared ? null : spaceMetric("/tmp", host.tmp),
    spaceMetric(labels.swap, host.swap),
  ].filter((metric): metric is Metric => metric !== null);
}

function workloadMetrics(row: Workload, host: Snapshot["host"]): Metric[] {
  const ramTotal = row.ram?.limit ?? host?.ram?.total ?? null;
  const ram = row.ram && ramTotal
    ? spaceMetric(labels.ram, { total: ramTotal, available: Math.max(0, ramTotal - row.ram.used) },
      row.ram.limit ? labels.cpuLimit : undefined)
    : row.ram ? { label: labels.ram, percent: null, value: bytes(row.ram.used), detail: bytes(row.ram.used) } : null;
  const cpu = row.cpu
    ? cpuMetric(row.cpu.used, row.cpu.limit ?? host?.cpus ?? null, row.cpu.limit ? labels.cpuLimit : labels.cpuHost)
    : null;
  const tmp = row.tmpShared ? null : spaceMetric("/tmp", row.tmp, labels.ownTmp);
  return [ram, cpu, tmp].filter((metric): metric is Metric => metric !== null);
}

/* -------------------------------------------------------------- headings */

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground", className)}>
      {children}
    </span>
  );
}

function StateLabel({ state }: { state: Workload["state"] }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-2xs",
      state === "unhealthy" ? "text-destructive" : "text-subtle-foreground")}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", stateDot[state])} />
      {labels[state]}
    </span>
  );
}

function NameInput({ name, original, onDone }: {
  name: string; original: string; onDone: (name: string | null) => void;
}) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input autoFocus defaultValue={name} placeholder={original} maxLength={80} aria-label={labels.rename}
      title={labels.renameHint} onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      className="h-5 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-transparent px-1 text-2xs font-medium text-sidebar-foreground outline-none focus:border-sidebar-ring" />
  );
}

function Heading({ icon, name, original, onRename, children, columns }: {
  icon: string; name: string; original: string;
  onRename: (name: string) => void; children?: ReactNode;
  /** Captions aligned with the percent and value columns of the metric grid. */
  columns?: [string, string];
}) {
  const [editing, setEditing] = useState(false);
  const heading = (
    <div className={cn("group/heading flex h-5 min-w-0 items-center gap-1.5", columns ? "col-span-2" : "col-span-full")}>
      <Icon name={icon} aria-hidden="true" className="size-3 shrink-0 text-subtle-foreground" />
      {editing ? (
        <NameInput name={name} original={original} onDone={(value) => {
          setEditing(false);
          if (value !== null && value.trim() !== name) onRename(value.trim() === original ? "" : value.trim());
        }} />
      ) : (
        <>
          <h3 title={name === original ? name : `${name} · ${original}`}
            className="min-w-0 truncate text-2xs font-medium text-sidebar-foreground">{name}</h3>
          <button type="button" aria-label={`${labels.rename}: ${name}`} title={labels.rename}
            onClick={() => setEditing(true)}
            className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm text-subtle-foreground opacity-0 hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/heading:opacity-100 pointer-coarse:opacity-100", focusRing)}>
            <Icon name="Edit" aria-hidden="true" className="size-2.5" />
          </button>
        </>
      )}
      <span className="flex-1" />
      {!editing && children}
    </div>
  );
  if (!columns) return heading;
  return (
    <div className="col-span-full grid h-5 grid-cols-subgrid items-center text-2xs text-subtle-foreground">
      {heading}
      <span className="text-right">{columns[0]}</span>
      <span className="min-w-9 text-right">{columns[1]}</span>
    </div>
  );
}

function Events({ row }: { row: Workload }) {
  const parts = [
    (row.oomKills ?? 0) > 0 ? `${labels.oom}: ${number(row.oomKills!, 0)}` : null,
    (row.restarts ?? 0) > 0 ? `${labels.restarts}: ${number(row.restarts!, 0)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className={cn("col-span-full flex h-5 items-center text-2xs", (row.oomKills ?? 0) > 0 ? "text-destructive" : "text-subtle-foreground")}>
      {parts.join(" · ")}
    </p>
  );
}

/* ---------------------------------------------------------------- blocks */

type Naming = { aliases: Aliases; rename: (key: string, name: string) => void };

const block = "col-span-full grid grid-cols-subgrid border-t border-sidebar-border pt-2.5 first:border-t-0 first:pt-0";

function HostBlock({ host, naming }: { host: NonNullable<Snapshot["host"]>; naming: Naming }) {
  return (
    <section aria-label={host.name} className={block}>
      <Heading icon="host-usage/rack" name={naming.aliases[HOST_KEY] ?? host.name} original={host.name}
        onRename={(name) => naming.rename(HOST_KEY, name)} columns={[labels.used, labels.free]} />
      {hostMetrics(host).map((metric) => <MetricRow key={metric.label} {...metric} />)}
    </section>
  );
}

function WorkloadBlock({ row, host, self, naming }: {
  row: Workload; host: Snapshot["host"]; self: boolean; naming: Naming;
}) {
  const key = workloadKey(row);
  const metrics = workloadMetrics(row, host);
  return (
    <section aria-label={row.name} className={block}>
      <Heading icon={row.runtime === "process" ? "ComputerTerminal01" : "host-usage/box"} name={naming.aliases[key] ?? row.name}
        original={row.name} onRename={(name) => naming.rename(key, name)}>
        {self && <Badge>{labels.thisBb}</Badge>}
        <StateLabel state={row.state} />
      </Heading>
      {metrics.map((metric) => <MetricRow key={metric.label} {...metric} />)}
      {metrics.length === 0 && <p className="col-span-full flex h-5 items-center text-2xs text-subtle-foreground">{labels.noMetrics}</p>}
      <Events row={row} />
    </section>
  );
}

function OtherRow({ row, host, naming }: { row: Workload; host: Snapshot["host"]; naming: Naming }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const key = workloadKey(row);
  const name = naming.aliases[key] ?? row.name;
  const cpuPercent = row.cpu ? percentOf(row.cpu.used, row.cpu.limit ?? host?.cpus ?? null) : null;
  const level = row.state === "unhealthy" ? "critical" : tone(cpuPercent);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}
        title={`${name} · ${labels[row.state]}`}
        className={cn("col-span-full grid h-5 grid-cols-subgrid items-center rounded-sm text-left text-2xs", focusRing)}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", stateDot[row.state])} />
          <span className={cn("min-w-0 truncate", row.state === "stopped" ? "text-subtle-foreground" : "text-sidebar-foreground")}>{name}</span>
        </span>
        <span className="text-right tabular-nums text-subtle-foreground">{row.ram ? bytes(row.ram.used) : "—"}</span>
        <span className={cn("min-w-8 text-right tabular-nums", level ? textColor[level] : "text-subtle-foreground")}>
          {cpuPercent === null ? "—" : `${Math.round(cpuPercent)}%`}
        </span>
      </button>
      {open && (
        <div className={cn("col-span-full mb-1 ml-[3px] border-l border-sidebar-border pl-2.5", metricGrid)}>
          <div className="col-span-full flex h-5 min-w-0 items-center gap-1.5">
            {editing ? (
              <NameInput name={name} original={row.name} onDone={(value) => {
                setEditing(false);
                if (value !== null && value.trim() !== name) naming.rename(key, value.trim() === row.name ? "" : value.trim());
              }} />
            ) : (
              <>
                <StateLabel state={row.state} />
                {name !== row.name && <span className="min-w-0 truncate text-2xs text-subtle-foreground" title={row.name}>· {row.name}</span>}
                <span className="flex-1" />
                <button type="button" onClick={() => setEditing(true)}
                  className={cn("flex shrink-0 items-center gap-1 rounded-sm text-2xs text-subtle-foreground hover:text-sidebar-foreground", focusRing)}>
                  <Icon name="Edit" aria-hidden="true" className="size-2.5" />
                  {labels.rename}
                </button>
              </>
            )}
          </div>
          {workloadMetrics(row, host).map((metric) => <MetricRow key={metric.label} {...metric} />)}
          <Events row={row} />
        </div>
      )}
    </>
  );
}

function OthersBlock({ rows, host, naming }: { rows: Workload[]; host: Snapshot["host"]; naming: Naming }) {
  const [open, setOpen] = useState(false);
  const alert = rows.some(needsAttention);
  return (
    <section aria-label={labels.others} className={cn(block, "gap-y-0")}>
      <button type="button" aria-expanded={open} disabled={rows.length === 0} onClick={() => setOpen((current) => !current)}
        className={cn("col-span-full flex h-5 min-w-0 items-center gap-1.5 rounded-sm text-left text-2xs disabled:cursor-default", focusRing)}>
        <Icon name="ChevronRight" aria-hidden="true"
          className={cn("size-3 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90", rows.length === 0 && "opacity-0")} />
        <span className="min-w-0 truncate font-medium text-sidebar-foreground">{rows.length ? labels.others : labels.none}</span>
        <span className="flex-1" />
        {alert && <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />}
        {rows.length > 0 && <span className="tabular-nums text-subtle-foreground">{rows.length}</span>}
      </button>
      {open && (
        <div className="col-span-full grid grid-cols-[minmax(0,1fr)_max-content_max-content] gap-x-3">
          <div aria-hidden="true" className="col-span-full grid h-4 grid-cols-subgrid items-center text-2xs text-subtle-foreground">
            <span />
            <span className="text-right">{labels.ram}</span>
            <span className="min-w-8 text-right">{labels.cpu}</span>
          </div>
          {rows.map((row) => <OtherRow key={row.id} row={row} host={host} naming={naming} />)}
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- panel */

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Reply | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef<Promise<Reply> | null>(null);
  const refresh = useCallback(() => {
    if (request.current) return;
    setLoading(true);
    const current = rpc.call("snapshot", null);
    request.current = current;
    current.then((result) => {
      if (request.current !== current) return;
      setData(result);
      setFailed(false);
    }, () => {
      if (request.current === current) setFailed(true);
    }).finally(() => {
      if (request.current !== current) return;
      request.current = null;
      setLoading(false);
    });
  }, [rpc]);
  const rename = useCallback((key: string, name: string) => {
    setData((current) => {
      if (!current) return current;
      const aliases = { ...current.aliases };
      if (name) aliases[key] = name;
      else delete aliases[key];
      return { ...current, aliases };
    });
    rpc.call("rename", { key, name }).then(
      (aliases) => setData((current) => current && { ...current, aliases }),
      () => refresh(),
    );
  }, [rpc, refresh]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => {
      clearInterval(timer);
      request.current = null;
    };
  }, [refresh]);
  return { data, failed, loading, refresh, rename };
}

function Notice({ icon, message, onRetry, retryLabel }: { icon: string; message: string; onRetry?: () => void; retryLabel: string }) {
  return (
    <div role="status" className="mb-2 flex min-w-0 items-start gap-1.5 text-2xs text-subtle-foreground">
      <Icon name={icon} aria-hidden="true" className={cn("mt-px size-3 shrink-0", icon === "AlertTriangle" && "text-warning")} />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className={cn("shrink-0 rounded-sm text-sidebar-foreground underline-offset-2 hover:underline", focusRing)}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div role="status" className="grid gap-y-1.5">
      {[0.4, 0.33, 0.45].map((width, index) => (
        <div key={index} className="flex h-5 items-center gap-2">
          <span className="h-2 w-8 animate-pulse rounded-full bg-sidebar-border" />
          <span className="h-1 flex-1 animate-pulse rounded-full bg-sidebar-border" style={{ maxWidth: `${width * 100}%` }} />
          <span className="flex-1" />
          <span className="h-2 w-9 animate-pulse rounded-full bg-sidebar-border" />
        </div>
      ))}
    </div>
  );
}

function sortWorkloads(rows: Workload[], aliases: Aliases, selfId: string | null) {
  const name = (row: Workload) => (aliases[workloadKey(row)] ?? row.name).toLocaleLowerCase();
  return [...rows].sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId) || name(a).localeCompare(name(b)));
}

function sortOthers(rows: Workload[]) {
  const rank = (row: Workload) => (needsAttention(row) ? 0 : row.state === "stopped" || row.state === "unknown" ? 2 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.ram?.used ?? 0) - (a.ram?.used ?? 0));
}

function Panel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { data, failed, loading, refresh, rename } = useSnapshot();
  const snapshot = data?.snapshot ?? null;
  const aliases = data?.aliases ?? {};
  const naming: Naming = { aliases, rename };
  const instances = sortWorkloads(snapshot?.workloads.filter((row) => row.bb) ?? [], aliases, data?.selfId ?? null);
  const others = sortOthers(snapshot?.workloads.filter((row) => !row.bb) ?? []);
  const measured = snapshot ? new Date(snapshot.measuredAt) : null;

  const notice = failed ? { icon: "CloudOff", message: labels.disconnected, retry: true }
    : data && data.status !== "fresh"
      ? { icon: data.status === "missing" ? "Info" : "AlertTriangle", message: labels[data.status], retry: data.status !== "missing" }
      : snapshot && snapshot.problems.length > 0 ? { icon: "AlertTriangle", message: labels.partial, retry: false }
        : snapshot && !snapshot.host ? { icon: "Info", message: labels.containerHost, retry: false }
          : null;

  return (
    <div className="flex max-h-[min(50svh,630px)] min-h-0 flex-col">
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5">
        <span className="px-1.5 text-2xs font-medium text-sidebar-foreground">{labels.title}</span>
        <span className="min-w-0 flex-1 truncate text-right text-2xs tabular-nums text-subtle-foreground"
          title={measured ? `${labels.measured} ${measured.toLocaleString()}` : undefined}>
          {measured?.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
        </span>
        <button type="button" aria-label={labels.refresh} title={labels.refresh} disabled={loading} onClick={refresh} className={iconButton}>
          <Icon name="RotateCcw" aria-hidden="true" className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button type="button" aria-label={labels.collapse} title={labels.collapse} onClick={dismiss} className={iconButton}>
          <Icon name="ChevronDown" aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-2.5">
        {notice && <Notice icon={notice.icon} message={notice.message} retryLabel={labels.retry}
          onRetry={notice.retry ? refresh : undefined} />}
        {!data && !failed && <Skeleton />}
        {snapshot && (
          <div className={cn(metricGrid, "gap-y-2.5")}>
            {snapshot.host && <HostBlock host={snapshot.host} naming={naming} />}
            {instances.map((row) => (
              <WorkloadBlock key={row.id} row={row} host={snapshot.host} self={row.id === data?.selfId}
                naming={naming} />
            ))}
            {instances.length === 0 && (
              <p className={cn(block, "text-2xs text-subtle-foreground")}>{labels.noInstances}</p>
            )}
            {data?.mode === "collector" && <OthersBlock rows={others} host={snapshot.host} naming={naming} />}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    id: "host-usage",
    kind: "disclosure",
    label: "Host Usage",
    icon: "host-usage/rack",
    component: Panel,
  });
});
