"""Prepare a local Wrangler config from explicit settings or endpoint metadata."""

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]


def r2_origin(value):
    if re.search(r"[\s*\\]", value):
        raise ValueError("R2 origin must not contain whitespace, wildcards, or backslashes")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname
            or not parsed.hostname.endswith(".r2.cloudflarestorage.com")
            or parsed.username or parsed.password or parsed.port
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("R2 origin must be an HTTPS R2 S3 endpoint without a bucket path or credentials")
    return f"https://{parsed.hostname}"


def allowed_origins(value):
    origins = []
    for item in value.split(","):
        item = item.strip()
        if re.search(r"[\s*\\]", item):
            raise ValueError("Allowed origins must not contain whitespace, wildcards, or backslashes")
        parsed = urlsplit(item)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError("Allowed origins must be comma-separated HTTP(S) origins without paths or credentials")
        port = parsed.port
        host = parsed.hostname
        if ":" in host:
            host = f"[{host}]"
        default_port = 443 if parsed.scheme == "https" else 80
        origin = f"{parsed.scheme}://{host}" + (f":{port}" if port and port != default_port else "")
        if origin not in origins:
            origins.append(origin)
    return ",".join(origins)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metadata", nargs="?", type=Path,
                        help="Optional JSON file containing r2_endpoint and r2_bucket; other fields are ignored")
    parser.add_argument("--r2-origin", help="R2 S3 HTTPS endpoint, without a bucket path")
    parser.add_argument("--bucket", help="Private R2 bucket name")
    parser.add_argument("--allowed-origins", required=True, help="Comma-separated Hapla browser origins")
    parser.add_argument("--name", help="Worker name (default: the checked-in template name)")
    parser.add_argument("--output", type=Path, default=ROOT / "wrangler.local.jsonc")
    args = parser.parse_args()
    try:
        metadata = json.loads(args.metadata.read_text()) if args.metadata else {}
        origin = args.r2_origin or metadata.get("r2_endpoint")
        bucket = args.bucket or metadata.get("r2_bucket")
        if not origin or not bucket:
            raise ValueError("Provide --r2-origin and --bucket, or an explicit metadata file")
        if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            raise ValueError("Bucket must contain 3–63 lowercase letters, digits, dots, or hyphens")
        template = ROOT / "wrangler.jsonc"
        target = args.output.resolve()
        if target == template.resolve():
            raise ValueError("Output must not overwrite the checked-in wrangler.jsonc template")
        config = json.loads(template.read_text())
        config["vars"] = {
            "R2_ORIGIN": r2_origin(origin),
            "R2_BUCKET": bucket,
            "ALLOWED_ORIGINS": allowed_origins(args.allowed_origins),
        }
        if args.name:
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", args.name):
                raise ValueError("Worker name must contain 1–63 lowercase letters, digits, or hyphens")
            config["name"] = args.name
        # Create with private permissions before writing, then replace atomically.
        with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False, encoding="utf-8") as output:
            temporary = Path(output.name)
            try:
                json.dump(config, output, indent=2)
                output.write("\n")
                output.close()
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        # Do not print input file contents, endpoint values, or credentials.
        if isinstance(error, (OSError, json.JSONDecodeError, TypeError, AttributeError)):
            parser.error("Unable to read configuration inputs or write the output file")
        parser.error(str(error))
    print("Prepared local Wrangler configuration; no credentials copied.")


if __name__ == "__main__":
    main()
