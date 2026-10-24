# Review guide

## What failure looks like

- A draft published without a confirm.
- An editor action a non-editor can reach (the `cms_identities` check skipped).
- A site that renders stale content after a publish (`content_version` not bumped).
- A relation the CMS creates without the `cms_` prefix, or any write to the site's `users` outside the dev-only loader.

## Nit cap

At most three nits per review; style and naming are not findings unless a convention in CLAUDE.md says so.

## Skip paths

```
bun.lock
**/dist/
coverage/
ux/
e2e/
```

## Evidence

Every finding names a file and line and quotes what's wrong there; nothing inferred from a name.

## Summary

Starts with a count; says "nothing to fix" plainly when that's true.
