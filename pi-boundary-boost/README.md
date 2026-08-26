# pi-boundary-boost

Rank **direct directory children first** in [pi](https://github.com/earendil-works/pi)'s `@` file completion.

![demo](https://raw.githubusercontent.com/cyzlmh/pi-extensions/main/pi-boundary-boost/demo.gif)

## The problem

pi's built-in `@` completion always routes to fd fuzzy search with `--max-results 100`. When you type a scoped query like `@~/projects/pro`, the result set floods with deep nested matches (`venv/.../site-packages/profile/…`), and the direct child you obviously meant can be cut by the 100-result cap before scoring even runs.

## The fix

Any `@<dir>/<prefix>` query reads `<dir>` directly via `readdir` and ranks its direct children matching `prefix` **first**, then merges the built-in fd fuzzy results (deduplicated) after them — so deep fuzzy search still works, but the obvious hit always appears.

- `@~/work/` → direct children of `~/work/` first, fd matches after
- `@src/comp` → `src/components/` ranks above `packages/foo/src/components/…`
- At the home root (`@~/<prefix>`), known noise dirs (`.cache`, `.npm`, `.nvm`, …) are filtered unless they themselves match the prefix
- Bare fuzzy queries without a `/` (`@foo`) and non-`@` queries pass through to the built-in provider unchanged

## Install

```sh
pi install npm:pi-boundary-boost
```

Zero configuration, zero dependencies. Works on top of the built-in completion provider (registered via `addAutocompleteProvider`), so it composes with pi's default behavior instead of replacing it.

## Compatibility

Tested with pi `0.84.x`. The extension wraps pi's autocomplete provider interface (`@earendil-works/pi-tui`), which is not yet a frozen API — if a future pi version changes completion internals, please open an issue.

## License

MIT — © cyzlmh. See [LICENSE](LICENSE).
