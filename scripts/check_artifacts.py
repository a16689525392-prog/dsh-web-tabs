#!/usr/bin/env python3
"""Check that both uploaded 0.2.1 archives match each other and tracked source.

This validates package identity/integrity, not runtime behavior on Windows.
"""
from pathlib import Path
import hashlib
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = [
    "ACCEPTANCE.zh.md", "README.md", "cordis.patch.yml",
    "install.ps1", "uninstall.ps1", "package.json", "screenshot.png",
    "lib/browsers.js", "lib/client.js", "lib/embed.js",
    "lib/index.js", "lib/settings.js", "native/win.ps1",
]


def compare_archive(path, entries, expected_prefix):
    expected = set(EXPECTED)
    if set(entries) != expected:
        raise SystemExit(f"{path.name}: paths mismatch: {set(entries) ^ expected}")
    for entry in EXPECTED:
        if entries[entry] != (ROOT / entry).read_bytes():
            raise SystemExit(f"{path.name}: file differs from repo: {entry}")
    print(f"OK: {path.name} ({len(entries)} files)")


with zipfile.ZipFile(ROOT / 'dist/dsh-web-tabs-0.2.1.zip') as z:
    entries = {}
    for item in z.infolist():
        path = item.filename.replace('\\', '/')
        if path.startswith('dsh-web-tabs/'):
            key = path[len('dsh-web-tabs/'):]
            if key:
                entries[key] = z.read(item)
    compare_archive(ROOT / 'dist/dsh-web-tabs-0.2.1.zip', entries, 'dsh-web-tabs/')
with tarfile.open(ROOT / 'dist/dsh-web-tabs-0.2.1.tgz', 'r:gz') as t:
    entries = {}
    for item in t.getmembers():
        if item.isfile() and item.name.startswith('package/'):
            entries[item.name[len('package/'):]] = t.extractfile(item).read()
    compare_archive(ROOT / 'dist/dsh-web-tabs-0.2.1.tgz', entries, 'package/')

checks = {name: digest for digest, name in (line.split('  ', 1) for line in (ROOT / 'dist/SHA256SUMS').read_text().splitlines())}
for filename in ['dsh-web-tabs-0.2.1.zip', 'dsh-web-tabs-0.2.1.tgz']:
    digest = hashlib.sha256((ROOT / 'dist' / filename).read_bytes()).hexdigest()
    if checks[filename] != digest:
        raise SystemExit(f"Hash mismatch: {filename}")
print('OK: SHA-256 checksums')
