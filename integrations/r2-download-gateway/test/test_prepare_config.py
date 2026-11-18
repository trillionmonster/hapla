import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/prepare-config.py"


class PrepareConfigTests(unittest.TestCase):
    def run_config(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True)

    def test_portable_config_contains_only_non_secret_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "wrangler.local.jsonc"
            result = self.run_config(
                "--r2-origin", "https://example-account.r2.cloudflarestorage.com/",
                "--bucket", "private-files", "--name", "my-download-gateway",
                "--allowed-origins", "https://hapla.example.com/,http://localhost:12345",
                "--output", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads(target.read_text())
            self.assertEqual(config["name"], "my-download-gateway")
            self.assertEqual(config["vars"]["R2_ORIGIN"], "https://example-account.r2.cloudflarestorage.com")
            self.assertEqual(config["vars"]["ALLOWED_ORIGINS"], "https://hapla.example.com,http://localhost:12345")
            if sys.platform != "win32":
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_metadata_credentials_are_never_copied_or_printed(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / "metadata.json"
            metadata.write_text(json.dumps({
                "r2_endpoint": "https://example-account.r2.cloudflarestorage.com",
                "r2_bucket": "private-files",
                "r2_secret_access_key": "private-test-value",
            }))
            target = Path(directory) / "output.jsonc"
            result = self.run_config(metadata, "--allowed-origins", "http://localhost:12345", "--output", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("private-test-value", target.read_text() + result.stdout + result.stderr)
            self.assertNotIn("r2_buckets", json.loads(target.read_text()))

    def test_invalid_inputs_do_not_replace_a_previous_config(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "output.jsonc"
            target.write_text("keep previous configuration")
            valid = ["--r2-origin", "https://example-account.r2.cloudflarestorage.com",
                     "--bucket", "private-files", "--allowed-origins", "http://localhost:12345"]
            invalid = [
                ["--r2-origin", "https://user:secret@example-account.r2.cloudflarestorage.com"],
                ["--r2-origin", "http://example-account.r2.cloudflarestorage.com"],
                ["--r2-origin", "https://example-account.r2.cloudflarestorage.com/bucket"],
                ["--bucket", "INVALID"],
                ["--allowed-origins", "*"],
                ["--allowed-origins", "https://*.example.com"],
                ["--allowed-origins", "https://bad host.example.com"],
                ["--allowed-origins", "https://hapla.example.com/path"],
                ["--allowed-origins", ""],
                ["--name", "invalid name"],
            ]
            for replacement in invalid:
                with self.subTest(replacement=replacement):
                    result = self.run_config(*valid, *replacement, "--output", target)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(target.read_text(), "keep previous configuration")
                    self.assertNotIn("user:secret", result.stderr)

    def test_no_machine_specific_metadata_default(self):
        result = self.run_config("--allowed-origins", "http://localhost:12345")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Provide --r2-origin and --bucket", result.stderr)


if __name__ == "__main__":
    unittest.main()
