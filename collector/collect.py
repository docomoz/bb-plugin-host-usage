#!/usr/bin/env python3
"""Take one local Linux snapshot for the Host Usage BB plugin."""

import argparse
import json
import os
import pwd
import re
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

PROC = Path("/proc")
CGROUPS = Path("/sys/fs/cgroup")
MAX_WORKLOADS = 500
CONTROLS = re.compile(r"[\x00-\x1f\x7f]")
BB_SERVER = re.compile(rb"/bb-app/(?:server/dist/index|dist/server(?:/index)?)\.m?js$")
CONTAINER_PATH = re.compile(r"(?:docker|libpod|kubepods|containerd|lxc)[/-]")


def inspect_format(runtime):
    health = '(index .State "Health")' if runtime == "docker" else ".State.Healthcheck"
    return (
        '{"id":{{json .Id}},"name":{{json .Name}},"pid":{{json .State.Pid}},'
        '"status":{{json .State.Status}},'
        f'"health":{{{{with {health}}}}}{{{{json .Status}}}}{{{{else}}}}null{{{{end}}}},'
        '"restarts":{{json .RestartCount}},'
        '"bb":{{with .Config.Labels}}{{json (index . "host-usage.bb")}}{{else}}null{{end}},'
        '"title":{{with .Config.Labels}}{{json (index . "host-usage.name")}}{{else}}null{{end}}}'
    )


def read(path):
    try:
        return path.read_text()
    except (OSError, UnicodeError):
        return ""


def integer(value):
    return int(value) if isinstance(value, str) and value.isascii() and value.isdecimal() else None


def fields(path):
    return {parts[0].rstrip(":"): int(parts[1])
            for line in read(path).splitlines()
            if len(parts := line.split()) >= 2 and integer(parts[1]) is not None}


def name(value, default):
    return (CONTROLS.sub(" ", value or "").strip() or default)[:160]


def space(total, available):
    return {"total": total, "available": min(total, max(0, available))} if total else None


def usage(used, limit=None):
    return {"used": used, "limit": limit or None} if used is not None else None


def filesystem(path):
    try:
        info = os.statvfs(path)
        return space(info.f_blocks * info.f_frsize, info.f_bavail * info.f_frsize)
    except OSError:
        return None


def same_filesystem(left, right):
    try:
        return left.stat().st_dev == right.stat().st_dev
    except OSError:
        return False


def ticks():
    first = read(PROC / "stat").partition("\n")[0].split()
    if len(first) < 9:
        return None
    values = list(map(int, first[1:9]))
    return sum(values), values[3] + values[4]


def cpu_percent(before, after):
    if before and after and after[0] > before[0]:
        return round(max(0, min(100, 100 * (1 - (after[1] - before[1]) / (after[0] - before[0])))), 1)
    return None


def host_sample(hostname, before):
    memory = fields(PROC / "meminfo")
    return {
        "name": name(hostname, "Linux"),
        "cpus": os.cpu_count(),
        "ram": space(memory.get("MemTotal", 0) * 1024, memory["MemAvailable"] * 1024)
        if "MemAvailable" in memory else None,
        "cpuPercent": cpu_percent(before, ticks()),
        "swap": space(memory.get("SwapTotal", 0) * 1024, memory["SwapFree"] * 1024)
        if "SwapFree" in memory else None,
        "disk": filesystem(Path("/")),
        "tmp": filesystem(Path("/tmp")),
        "tmpShared": same_filesystem(Path("/"), Path("/tmp")),
    }


def command(args, **options):
    return subprocess.run(args, capture_output=True, timeout=7, check=False, **options)


def inventory(cli, runtime, problems):
    try:
        listing = command([*cli, "container", "ls", "--all", "--quiet", "--no-trunc"], text=True)
        if listing.returncode:
            problems.add(runtime)
            return []
        ids = [row for row in listing.stdout.splitlines() if re.fullmatch(r"[0-9a-f]{64}", row)]
        if not ids:
            return []
        if len(ids) > MAX_WORKLOADS:
            problems.add("inventory")
        inspected = command([*cli, "container", "inspect", "--format", inspect_format(runtime), *ids[:MAX_WORKLOADS]],
                            text=True)
        if inspected.returncode or len(inspected.stdout.splitlines()) != min(len(ids), MAX_WORKLOADS):
            problems.add("inventory")
        return [{**json.loads(line), "runtime": runtime} for line in inspected.stdout.splitlines()]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        problems.add(runtime)
        return []


def container_state(container):
    status = container["status"].lower()
    if status in {"restarting", "starting"}:
        return "starting"
    if status == "running":
        health = container["health"]
        return health if health in {"healthy", "unhealthy", "starting"} else "running"
    if status == "paused":
        return "paused"
    return "stopped" if status in {"exited", "stopped", "created", "configured", "dead", "initialized"} else "unknown"


def cgroup_path(pid):
    for line in read(PROC / str(pid) / "cgroup").splitlines():
        if line.startswith("0::/"):
            path = CGROUPS / line[4:]
            if ".." not in path.parts:
                return path
    return None


def quota(group):
    values = read(group / "cpu.max").split()
    if len(values) == 2 and (limit := integer(values[0])) and (period := integer(values[1])):
        return limit / period
    return None


def cgroup_cpu(group):
    return fields(group / "cpu.stat").get("usage_usec") if group else None


def rate(before, after, seconds, units):
    if before is None or after is None or after < before or seconds <= 0:
        return None
    return round((after - before) / units / seconds, 3)


def is_bb_server(cmdline):
    args = cmdline.split(b"\x00")
    return any(BB_SERVER.search(arg) for arg in args[:1]) or (
        args[0].rsplit(b"/", 1)[-1] in {b"bb", b"bb-server"} and args[1:2] == [b"serve"]
    ) or (
        args[0].rsplit(b"/", 1)[-1] in {b"node", b"nodejs"}
        and any(BB_SERVER.search(arg) for arg in args[1:8])
    )


def discover_bb():
    servers = []
    for proc in PROC.iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            with (proc / "cmdline").open("rb") as handle:
                if not is_bb_server(handle.read(4096)):
                    continue
        except OSError:
            continue
        servers.append(proc)
    return servers


def process_sample(proc):
    # comm can contain spaces and closing parentheses. The fields after comm are numeric except state.
    stats = read(proc / "stat").rsplit(")", 1)[-1].split()
    if len(stats) < 22 or stats[0] in {"Z", "X"}:
        return None
    return int(stats[11]) + int(stats[12]), stats[19], max(0, int(stats[21])) * os.sysconf("SC_PAGE_SIZE")


def workload(id_, key, label, bb, runtime, state, **measurements):
    return {
        "id": id_, "key": name(key, id_), "name": name(label, id_), "bb": bb, "runtime": runtime, "state": state,
        "ram": None, "cpu": None, "tmp": None, "tmpShared": False, "oomKills": None, "restarts": None,
        **measurements,
    }


def temp_usage(proc):
    root = proc / "root"
    return {"tmp": filesystem(root / "tmp"), "tmpShared": same_filesystem(root, root / "tmp")}


def process_owner(proc):
    """Host-side real UID of a process, or None."""
    for line in read(proc / "status").splitlines():
        if line.startswith("Uid:"):
            parts = line.split()
            return integer(parts[1]) if len(parts) > 1 else None
    return None


def user_name(uid):
    try:
        return pwd.getpwuid(uid).pw_name
    except (KeyError, TypeError):
        return str(uid)


def publish_identity(proc):
    """UID inside the process's user namespace and its HOME, for writing a snapshot as that BB user."""
    uid = process_owner(proc)
    if uid is None:
        return None
    inner = uid
    for line in read(proc / "uid_map").splitlines():
        parts = [integer(part) for part in line.split()]
        if len(parts) == 3 and None not in parts and parts[1] <= uid < parts[1] + parts[2]:
            inner = parts[0] + uid - parts[1]
            break
    try:
        environ = (proc / "environ").read_bytes()
    except OSError:
        return None
    home = next((item[5:].decode("utf-8", "replace") for item in environ.split(b"\0")
                 if item.startswith(b"HOME=")), "")
    if not home.startswith("/") or CONTROLS.search(home) or ".." in Path(home).parts:
        return None
    return inner, str(Path(home) / ".local" / "share" / "bb-host-usage" / "latest.json")


def docker_cli(socket_path):
    if socket_path is None:
        candidates = ["/var/run/docker.sock"]
        if os.environ.get("XDG_RUNTIME_DIR"):
            candidates.append(str(Path(os.environ["XDG_RUNTIME_DIR"]) / "docker.sock"))
        socket_path = next((path for path in candidates if Path(path).is_socket()), None)
    if socket_path and (docker := shutil.which("docker")):
        return [docker, "--host", f"unix://{socket_path}"]
    return None


def collect(args):
    problems = set()
    containers = []
    docker = docker_cli(args.docker_socket)
    podman = shutil.which("podman")
    if args.runtime in {"auto", "docker"}:
        if docker:
            containers += inventory(docker, "docker", problems)
        elif args.runtime == "docker" or args.docker_socket:
            problems.add("docker")
    if args.runtime in {"auto", "podman"}:
        if podman:
            containers += inventory([podman, "--remote=false"], "podman", problems)
        elif args.runtime == "podman":
            problems.add("podman")

    groups = {}
    for container in containers:
        pid = container["pid"]
        group = cgroup_path(pid) if pid > 0 else None
        # A PID returned by a runtime must belong to this container on the local kernel.
        groups[container["id"]] = group if group and container["id"] in str(group) else None

    bb_groups = {}
    native_bb = []
    try:
        for proc in discover_bb():
            paths = read(proc / "cgroup")
            group = cgroup_path(proc.name)
            # Compare PID namespaces as well to keep a BB in an unknown container
            # from being listed as a service of the physical host.
            if CONTAINER_PATH.search(paths) or (group is not None and group in groups.values()):
                if group:
                    for parent in (group, *group.parents):
                        if parent != CGROUPS and CGROUPS in parent.parents:
                            bb_groups.setdefault(parent, proc)
            else:
                try:
                    if (proc / "ns/pid").readlink() == (PROC / "1/ns/pid").readlink():
                        native_bb.append(proc)
                except OSError:
                    problems.add("processes")
    except OSError:
        problems.add("processes")

    started = time.monotonic()
    before_host = ticks()
    before_cpu = {id_: cgroup_cpu(group) for id_, group in groups.items()}
    before_process = {proc: process_sample(proc) for proc in native_bb}
    time.sleep(args.sample_seconds)
    host = host_sample(args.name, before_host)
    after_cpu = {id_: cgroup_cpu(group) for id_, group in groups.items()}
    after_process = {proc: process_sample(proc) for proc in native_bb}
    elapsed = time.monotonic() - started

    workloads = []
    targets = []
    for container in containers:
        id_ = container["id"]
        container_name = container["name"].lstrip("/")
        state = container_state(container)
        group = groups[id_]
        pid = container["pid"]
        bb = container["bb"] == "true" or container_name in args.bb or group in bb_groups
        label = args.bb.get(container_name) or container["title"] or container_name
        row = workload(f'{container["runtime"]}:{id_}', f'{container["runtime"]}:{container_name}', label, bb,
                       container["runtime"], state, restarts=container["restarts"])
        if bb and group in bb_groups and state in {"running", "healthy", "unhealthy", "starting"}:
            targets.append((container["runtime"], id_, bb_groups[group]))
        if group and cgroup_path(pid) == group:
            # A busy cgroup can momentarily exceed memory.max under reclaim.
            used = integer(read(group / "memory.current").strip())
            limit = integer(read(group / "memory.max").strip())
            row.update(ram=usage(used, limit),
                       cpu=usage(rate(before_cpu[id_], after_cpu[id_], elapsed, 1_000_000), quota(group)),
                       oomKills=fields(group / "memory.events").get("oom_kill"),
                       **temp_usage(PROC / str(pid)))
        elif state in {"running", "healthy", "unhealthy", "paused"}:
            problems.add("cgroups")
        workloads.append(row)

    native_keys = set()
    for proc, after in after_process.items():
        before = before_process[proc]
        if before and after and before[1] == after[1]:
            owner = process_owner(proc)
            key = f"process:{user_name(owner)}"
            if key in native_keys:
                key = f"{key}:{proc.name}"
            native_keys.add(key)
            workloads.append(workload(
                f"process:{proc.name}:{after[1]}", key, f"BB · {user_name(owner)}", True, "process", "running",
                ram=usage(after[2]),
                cpu=usage(rate(before[0], after[0], elapsed, os.sysconf("SC_CLK_TCK"))),
                **temp_usage(proc),
            ))

    workloads.sort(key=lambda row: (not row["bb"], row["name"].casefold(), row["id"]))
    if len(workloads) > MAX_WORKLOADS:
        problems.add("inventory")
    return {
        "version": 1, "measuredAt": int(time.time() * 1000), "periodSeconds": args.period,
        "host": host, "workloads": workloads[:MAX_WORKLOADS], "problems": sorted(problems),
    }, targets


def write_snapshot(path, payload):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".snapshot-", delete=False) as temporary:
        try:
            temporary.write(payload)
            temporary.close()
            os.replace(temporary.name, path)
        finally:
            Path(temporary.name).unlink(missing_ok=True)


PUBLISH = """
umask 077
dir=$(dirname -- "$1")
mkdir -p -- "$dir"
tmp=$(mktemp "$dir/.snapshot-XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
test ! -d "$1"
mv -f -- "$tmp" "$1"
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", choices=["auto", "docker", "podman", "none"], default="auto")
    parser.add_argument("--docker-socket", help="Local Docker socket path")
    parser.add_argument("--name", default=socket.gethostname().split(".")[0], help="Host display name")
    parser.add_argument("--bb", action="append", default=[], metavar="CONTAINER=LABEL",
                        help="Mark a container as BB and set its display name. Repeatable.")
    parser.add_argument("--period", type=int, default=30, help="Seconds between captures")
    parser.add_argument("--sample-seconds", type=float, default=1.0, help="CPU averaging interval")
    parser.add_argument("--output", type=Path, help="Absolute snapshot file path. Default: stdout.")
    parser.add_argument("--publish-bb", action="store_true",
                        help="Also write the snapshot into every running BB container, as the user and HOME of its BB server")
    parser.add_argument("--publish-docker", help="Write the snapshot within this local Docker container")
    parser.add_argument("--publish-user", default="node", help="Unprivileged user inside the receiving container")
    args = parser.parse_args()
    if not 5 <= args.period <= 3600 or not 0.1 <= args.sample_seconds <= 5:
        parser.error("Period must be 5–3600 seconds and sample interval must be 0.1–5 seconds.")
    if any("=" not in item or not all(item.split("=", 1)) for item in args.bb):
        parser.error("Every --bb value must be CONTAINER=LABEL.")
    args.bb = dict(item.split("=", 1) for item in args.bb)
    if ((args.publish_docker and args.output is None) or (args.output and not args.output.is_absolute())):
        parser.error("Specify an absolute --output path when publishing.")
    if args.docker_socket and not Path(args.docker_socket).is_absolute():
        parser.error("The Docker socket path must be absolute.")
    if not PROC.is_dir():
        parser.error("The collector requires a Linux host.")

    snapshot, targets = collect(args)
    payload = (json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    failed = []
    if args.publish_bb:
        podman = shutil.which("podman")
        clis = {"docker": docker_cli(args.docker_socket), "podman": podman and [podman, "--remote=false"]}
        for runtime, container_id, proc in targets:
            identity = publish_identity(proc)
            if not identity or not clis.get(runtime):
                failed.append(container_id[:12])
                continue
            uid, path = identity
            try:
                result = command([*clis[runtime], "exec", "-i", "--user", str(uid), container_id,
                                  "sh", "-ecu", PUBLISH, "host-usage", path], input=payload)
            except (OSError, subprocess.TimeoutExpired):
                result = None
            if result is None or result.returncode:
                failed.append(container_id[:12])
    if args.publish_docker:
        docker = docker_cli(args.docker_socket)
        if not docker:
            parser.error("A local Docker socket is required for --publish-docker.")
        if args.publish_docker.startswith("-"):
            parser.error("The receiving container name must not start with '-'.")
        result = command([*docker, "exec", "-i", "--user", args.publish_user, args.publish_docker,
                          "sh", "-ecu", PUBLISH, "host-usage", str(args.output)], input=payload)
        if result.returncode:
            parser.exit(1, "Could not publish the snapshot to the receiving container.\n")
    elif args.output:
        write_snapshot(args.output, payload)
    elif not args.publish_bb:
        print(payload.decode(), end="")
    if failed:
        parser.exit(1, f"Could not publish the snapshot to BB containers: {', '.join(failed)}\n")


if __name__ == "__main__":
    main()
