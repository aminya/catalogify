# catalogify

Move shared workspace dependency versions into a Bun or pnpm catalog. Run from the workspace root, or pass the path to a workspace:

```sh
bunx catalogify
bunx catalogify --dedupe major --pm pnpm
bunx catalogify --dedupe all --dry-run
bunx catalogify /path/to/workspace
```

`--pm` selects `bun` or `pnpm`; otherwise the root `packageManager` field or lockfile determines it. Bun's default catalog is stored in the root `package.json`, and pnpm's is stored in `pnpm-workspace.yaml`. npm does not support the `catalog:` protocol, so `--pm npm` fails without modifying files.

Dependencies used by at least two workspace packages (including the root package) are considered across dependencies, devDependencies, peerDependencies and optionalDependencies. Existing default catalog entries are preserved and considered when choosing a version. Unsupported specifications such as `workspace:`, Git URLs, aliases, tags and named catalogs are skipped with a warning.

`--dedupe` controls which ranges may be combined:

- `semver` (default): require a nonempty intersection across all ranges and use a range within that intersection. Incompatible dependencies are warned about and left unchanged.
- `major`: require the minimum version of each range to have the same major, then use the range with the highest minimum version. This can change accepted versions.
- `all`: ignore major differences and use the latest version from the npm registry (or `npm_config_registry` when set). Registry lookup failures leave that dependency unchanged. This can introduce breaking changes.

`--dry-run` reports the number of candidates and warnings without writing files. Run your package manager's install afterward to update the lockfile and verify resolution. Review the diff before committing.
