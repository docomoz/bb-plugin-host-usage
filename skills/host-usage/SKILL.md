---
name: host-usage
description: Read the latest Host Usage snapshot for host resources, BB instances, and local containers.
---

# Read Host Usage

Use `bb plugin rpc call host-usage snapshot --json`. Check `status` and `snapshot.measuredAt` before reporting metrics. A stale snapshot is useful as a dated observation. A missing measurement is unknown.

`snapshot` also returns `selfId` (the workload this BB runs in) and `aliases`, the display names chosen in this installation, keyed by `host` or by a workload's `key`. Prefer an alias over `name` when you report. Rename with `bb plugin rpc call host-usage rename --input-file <json>`, where the JSON is `{"key": "docker:my-bb", "name": "Team BB"}`. An empty `name` restores the original.

The footer's Host Usage icon opens the dashboard. The installation setting `snapshotPath` is an absolute file path on the BB server. The optional Linux collector is configured on the host. See the plugin README for its flags and installation examples.
