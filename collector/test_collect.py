import unittest

import os
import tempfile
from pathlib import Path

from collect import container_state, cpu_percent, is_bb_server, publish_identity, rate, space, workload


class CollectorTest(unittest.TestCase):
    def test_bb_server_with_node_flags_is_discovered(self):
        args = b"\x00".join((b"/usr/bin/node", b"--enable-source-maps",
                            b"/opt/bb/node_modules/bb-app/server/dist/index.js"))
        self.assertTrue(is_bb_server(args))
        self.assertTrue(is_bb_server(b"/usr/local/bin/bb\x00serve\x00"))
        self.assertFalse(is_bb_server(b"bb\x00thread\x00list\x00"))
        self.assertFalse(is_bb_server(b"node\x00/opt/bb/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs"))

    def test_health_is_distinct_from_running_and_exited(self):
        self.assertEqual(container_state({"status": "running", "health": None}), "running")
        self.assertEqual(container_state({"status": "running", "health": "unhealthy"}), "unhealthy")
        self.assertEqual(container_state({"status": "exited", "health": "unhealthy"}), "stopped")
        self.assertEqual(container_state({"status": "paused", "health": "healthy"}), "paused")

    def test_samples_distinguish_zero_and_missing_counters(self):
        self.assertEqual(rate(0, 0, 1, 1_000_000), 0.0)
        self.assertIsNone(rate(2, 1, 1, 1_000_000))
        self.assertIsNone(rate(None, 1, 1, 1_000_000))
        self.assertEqual(cpu_percent((100, 30), (200, 100)), 30)
        self.assertEqual(space(384, 0), {"total": 384, "available": 0})

    def test_workloads_carry_a_stable_key_for_user_names(self):
        row = workload("docker:abc", "docker:bb-staging", "bb-staging", True, "docker", "running")
        self.assertEqual((row["key"], row["name"]), ("docker:bb-staging", "bb-staging"))

    def test_publish_identity_maps_namespaced_uid_and_home(self):
        with tempfile.TemporaryDirectory() as root:
            proc = Path(root)
            (proc / "status").write_text("Name:\tnode\nUid:\t101000\t101000\t101000\t101000\n")
            (proc / "uid_map").write_text("         0     100000      65536\n")
            (proc / "environ").write_bytes(b"PATH=/bin\0HOME=/home/node\0")
            self.assertEqual(publish_identity(proc),
                             (1000, "/home/node/.local/share/bb-host-usage/latest.json"))
            (proc / "environ").write_bytes(b"HOME=relative\0")
            self.assertIsNone(publish_identity(proc))


if __name__ == "__main__":
    unittest.main()
