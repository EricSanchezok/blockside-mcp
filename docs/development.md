# Development

English is the working language of this repository.

## Prerequisites

- Git
- Node.js 18 or later for the dependency-free governance scripts

## Daily workflow

1. Follow the branching convention and contribution workflow in [CONTRIBUTING.md](../CONTRIBUTING.md).
2. Update the documents affected by the change and review their wording against the repository state.
3. Run the [governance gates](../AGENTS.md#commands).
4. Commit with a message that explains the change. Link any decision record the change updates.

## Source attribution

The governance scripts and templates come from this pinned upstream revision. [Repo Seed 0.6.5](https://github.com/EricSanchezok/repo-seed/tree/559b84dec5c7c495df274820b4b2e6c611d304b3)

When an implementation is materially derived from a paper, article, community post, benchmark, research report, or copied/adapted code, preserve that provenance at the closest stable repository location:

- For a local algorithm, formula, constant, workaround, or behavior, add a nearby `Source:` comment with a descriptive title, a stable URL or DOI, and what the implementation derived from it.
- For a cross-cutting design, link the implementation entry point to the owning decision record and list the external sources in that record's `## Links` section.
- For generated, vendored, copied, or adapted material, retain the source header or metadata and satisfy the applicable copyright, license, and NOTICE requirements; a citation does not replace license compliance.
- For mutable community pages, include the relevant version or section and an access date when it helps future readers recover the cited evidence.

Routine language idioms and standard-library usage do not need citations. A pull request, issue, prompt, or chat transcript may supplement repository provenance but is never its only home because it can become detached from the implementation.

Example:

```text
// Source: "Exponential Backoff and Jitter" — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
// Derived: full jitter prevents synchronized retries.
```

## Working tree

The manifest lists the files managed by Repo Seed. Follow the update strategy when changing those files. [Manifest](../.repo-seed/manifest.json) and [update strategy](../.repo-seed/update-strategy.md)

## Editing docs

Follow [docs/AGENTS.md](AGENTS.md): one home per fact, tutorials vs references, hygiene checklist.
