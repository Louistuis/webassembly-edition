# Contributing

Issues and pull requests are welcome. A few rules keep this project safe to share:

- **Never commit Mojang's files**: game jars, assets, prepared resources (`.local/`), screenshots of them.
  `tools/check_public_tree.py` checks the tree; `git config core.hooksPath .githooks` runs it on commit.
- **Browser work goes in `web/`** or behind `cfg(target_arch = "wasm32")`, so the engine underneath stays
  Horizon's ([docs/web.md](docs/web.md) explains the split).
- **Test headless**, under a memory limit (`systemd-run --scope -p MemoryMax=3G`), never in a browser on a
  small machine: a runaway WebGPU tab can take the machine down. The scripts are in `web/test/`.
- Fixes to the engine itself belong upstream, in [Horizon](https://github.com/horizon-rust/horizon), whose own
  guide is [docs/horizon/CONTRIBUTING.md](docs/horizon/CONTRIBUTING.md).
