#!/usr/bin/env python3
"""Packs prepared resources for the browser build (docs/web.md).

Reads a prepared `.local/horizon-client/26.3` folder (horizon-prepare's output,
made from the player's own Minecraft) and writes, to OUT:

  index.json        every file: group, chunk, offset, length
  core-NNN.bin      gzip chunks the page fetches before the game starts
  sound-NNN-H.bin   gzip chunks of the sound files, fetched when sound plays:
                    small ones, a sound folder at a time, and every music
                    track and record on its own (H: a hash of the contents,
                    so a browser never plays a stale copy)

These are Mojang's files: they never go into this repository or onto a public
page (CLAUDE.md, "Never commit Mojang's files").

    python3 web/pack.py PREPARED_DIR OUT_DIR [--langs en_us,no_no,nn_no]

PREPARED_DIR may also be an earlier pack (a folder with index.json): its files
are packed again, as this version lays them out.
"""
import argparse
import gzip
import hashlib
import json
import os
import pathlib

CHUNK = 24 << 20  # raw bytes per chunk before compression
SOUND_CHUNK = 2 << 20  # sounds come when asked for: small chunks
ALONE = ("music", "records")  # sound folders whose files are fetched one by one


def group_of(rel, langs):
    if rel.endswith(".log") or rel.startswith(("classes/", "client-classes/")):
        return None
    if rel.startswith("assets/minecraft/sounds/") and rel.endswith(".ogg"):
        return "sound"
    if rel.startswith("assets/minecraft/lang/") and rel.endswith(".json"):
        name = rel.rsplit("/", 1)[1][:-5]
        return "core" if name in langs else None
    return "core"


class Packed:
    """A file inside an earlier pack."""

    last = (None, b"")  # the chunk read last, unpacked

    def __init__(self, pack, chunk, offset, length):
        self.pack, self.chunk, self.offset, self.length = pack, chunk, offset, length

    def read_bytes(self):
        if Packed.last[0] != self.chunk:
            Packed.last = (self.chunk, gzip.decompress((self.pack / self.chunk).read_bytes()))
        return Packed.last[1][self.offset : self.offset + self.length]


def files_of(root, langs):
    """Every file to pack: (path inside the resources, something to read it from)."""
    if (root / "index.json").exists():
        old = json.loads((root / "index.json").read_text())
        for rel, (group, chunk, offset, length) in old["files"].items():
            yield rel, Packed(root, old["chunks"][group][chunk]["name"], offset, length)
        return
    for dirpath, _, names in os.walk(root):
        for name in sorted(names):
            path = pathlib.Path(dirpath) / name
            yield path.relative_to(root).as_posix(), path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("prepared")
    parser.add_argument("out")
    parser.add_argument("--langs", default="en_us,no_no,nn_no")
    args = parser.parse_args()
    root = pathlib.Path(args.prepared)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.bin"):
        old.unlink()
    langs = set(args.langs.split(","))

    groups = {"core": [], "sound": []}
    if out.resolve() == root.resolve():
        parser.error("pack into another folder than the one read")
    for rel, path in files_of(root, langs):
        group = group_of(rel, langs)
        if group:
            groups[group].append((rel, path))

    index = {"files": {}, "chunks": {}}
    for group, files in groups.items():
        files.sort(key=lambda f: f[0])
        chunks = []
        buf = bytearray()

        sound = group == "sound"
        limit = SOUND_CHUNK if sound else CHUNK
        folder = None  # the sound folder the open chunk holds

        def flush():
            if not buf:
                return
            if sound:
                # Ogg does not shrink: the lightest gzip, for the page's one way in.
                data = gzip.compress(bytes(buf), compresslevel=1, mtime=0)
                name = f"sound-{len(chunks):03d}-{hashlib.sha256(data).hexdigest()[:10]}.bin"
                chunk = {"name": name, "raw": len(buf), "size": len(data), "dir": folder}
            else:
                data = gzip.compress(bytes(buf), compresslevel=9, mtime=0)
                name = f"{group}-{len(chunks):03d}.bin"
                chunk = {"name": name, "raw": len(buf), "size": len(data)}
            (out / name).write_bytes(data)
            chunks.append(chunk)
            buf.clear()

        for rel, path in files:
            data = path.read_bytes()
            if sound:
                # assets/minecraft/sounds/<folder>/...
                parts = rel.split("/")
                here = parts[3] if len(parts) > 4 else ""
                if buf and (here != folder or here in ALONE):
                    flush()
                folder = here
            if buf and len(buf) + len(data) > limit:
                flush()
            index["files"][rel] = [group, len(chunks), len(buf), len(data)]
            buf.extend(data)
        flush()
        index["chunks"][group] = chunks
        raw = sum(c["raw"] for c in chunks)
        packed = sum(c["size"] for c in chunks)
        print(f"{group}: {len(files)} files, {raw / 1e6:.1f} MB -> {packed / 1e6:.1f} MB in {len(chunks)} chunks")
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))


if __name__ == "__main__":
    main()
