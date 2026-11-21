#!/usr/bin/env python3
"""Packs prepared resources for the browser build (docs/web.md).

Reads a prepared `.local/horizon-client/26.3` folder (horizon-prepare's output,
made from the player's own Minecraft) and writes, to OUT:

  index.json        every file: group, chunk, offset, length
  core-NNN.bin      gzip chunks the page fetches before the game starts
  sound-NNN.bin     gzip chunks of the sound files, fetched when sound plays

These are Mojang's files: they never go into this repository or onto a public
page (CLAUDE.md, "Never commit Mojang's files").

    python3 web/pack.py PREPARED_DIR OUT_DIR [--langs en_us,no_no,nn_no]
"""
import argparse
import gzip
import json
import os
import pathlib

CHUNK = 24 << 20  # raw bytes per chunk before compression


def group_of(rel, langs):
    if rel.endswith(".log") or rel.startswith(("classes/", "client-classes/")):
        return None
    if rel.startswith("assets/minecraft/sounds/") and rel.endswith(".ogg"):
        return "sound"
    if rel.startswith("assets/minecraft/lang/") and rel.endswith(".json"):
        name = rel.rsplit("/", 1)[1][:-5]
        return "core" if name in langs else None
    return "core"


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
    for dirpath, _, names in os.walk(root):
        for name in sorted(names):
            path = pathlib.Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            group = group_of(rel, langs)
            if group:
                groups[group].append((rel, path))

    index = {"files": {}, "chunks": {}}
    for group, files in groups.items():
        files.sort()
        chunks = []
        buf = bytearray()

        def flush():
            if not buf:
                return
            name = f"{group}-{len(chunks):03d}.bin"
            data = gzip.compress(bytes(buf), compresslevel=9, mtime=0)
            (out / name).write_bytes(data)
            chunks.append({"name": name, "raw": len(buf), "size": len(data)})
            buf.clear()

        for rel, path in files:
            data = path.read_bytes()
            if buf and len(buf) + len(data) > CHUNK:
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
