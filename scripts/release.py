"""Cut a release: bump every version string, write the changelog entry, run the gates, commit and tag.

    make release VERSION=0.3.0

The version lives in seven places, and they drift when bumped by hand: the four package.json files, pyproject.toml, the rt511 entry in uv.lock, and the User-Agent in data/sources.json that every agency sees. This changes all of them together. uv.lock is edited on the one line rather than regenerated, because `uv lock` also rewrites unrelated platform markers.

A hand-written summary in docs/releases/<version>.md, if present, opens the changelog entry and serves as the GitHub release notes.

It refuses to run on anything but a clean main that matches its upstream, refuses a version that does not move forward, and commits nothing unless `make check`, `make test` and `make smoke` pass. It never pushes; it prints the command.
"""

import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ["package.json", "server/package.json", "web/package.json", "shared/package.json"]
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else ""


def fail(message: str) -> None:
    sys.exit(f"release: {message}")


def current_version() -> str:
    return json.loads((ROOT / "package.json").read_text())["version"]


def replace_once(path: Path, pattern: str, replacement: str) -> None:
    text = path.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        fail(f"could not find the version in {path.relative_to(ROOT)}")
    path.write_text(updated)


def bump(version: str) -> None:
    for name in PACKAGES:
        replace_once(ROOT / name, r'^(  "version": )"[^"]*"', rf'\1"{version}"')
    replace_once(ROOT / "pyproject.toml", r'^version = "[^"]*"', f'version = "{version}"')
    replace_once(ROOT / "uv.lock", r'^(name = "rt511"\nversion = )"[^"]*"', rf'\1"{version}"')
    replace_once(ROOT / "data" / "sources.json", r'("user_agent": "rt511/)[^ ]*( )', rf"\g<1>{version}\2")


def changelog(version: str, previous_tag: str) -> None:
    """Prepends this release's entry: its date and the subject of every commit since the last release."""
    subjects = run("git", "log", "--reverse", "--format=%s", f"{previous_tag}..HEAD", capture=True).splitlines()
    notes = ROOT / "docs" / "releases" / f"{version}.md"
    summary = notes.read_text().strip() + "\n\nEvery change:\n\n" if notes.exists() else ""
    entry = f"## {version} ({datetime.date.today().isoformat()})\n\n" + summary + "".join(f"- {subject}\n" for subject in subjects) + "\n"
    path = ROOT / "CHANGELOG.md"
    head = "# Changelog\n\nEach release lists the commits it carries, in the order they landed.\n\n"
    body = path.read_text().removeprefix(head) if path.exists() else ""
    path.write_text(head + entry + body)


def notes_exist(version: str) -> bool:
    return (ROOT / "docs" / "releases" / f"{version}.md").exists()


def main() -> None:
    if len(sys.argv) != 2 or not SEMVER.match(sys.argv[1]):
        fail("usage: make release VERSION=x.y.z")
    version = sys.argv[1]
    old = current_version()
    if tuple(map(int, SEMVER.match(version).groups())) <= tuple(map(int, SEMVER.match(old).groups())):
        fail(f"{version} does not come after the current {old}")
    if run("git", "rev-parse", "--abbrev-ref", "HEAD", capture=True) != "main":
        fail("releases are cut from main")
    if run("git", "status", "--porcelain", capture=True):
        fail("the working tree has changes; commit or stash them first")
    run("git", "fetch", "--quiet", "origin", "main")
    if run("git", "rev-parse", "HEAD", capture=True) != run("git", "rev-parse", "origin/main", capture=True):
        fail("main does not match origin/main; push or pull first")
    previous_tag = run("git", "describe", "--tags", "--match", "v*", "--abbrev=0", capture=True)

    bump(version)
    changelog(version, previous_tag)
    try:
        run("make", "check")
        run("make", "test")
        run("make", "build")
        run("make", "smoke")
    except subprocess.CalledProcessError:
        run("git", "checkout", "--", ".")
        run("git", "clean", "-fq", "CHANGELOG.md")
        fail("a gate failed; the version bump has been undone")

    run("git", "add", *PACKAGES, "pyproject.toml", "uv.lock", "data/sources.json", "CHANGELOG.md")
    run("git", "commit", "-q", "-m", f"Call it {version}")
    run("git", "tag", "-a", f"v{version}", "-m", f"rt511 {version}")
    print(f"release: v{version} committed and tagged. Publish with:\n  git push origin main v{version}")
    if notes_exist(version):
        print(f"  gh release create v{version} --title 'rt511 {version}' --notes-file docs/releases/{version}.md")


if __name__ == "__main__":
    main()
