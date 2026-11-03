# Bambuddy (hyyz17200 personal fork)

> **This is an unofficial personal fork of [maziggy/bambuddy](https://github.com/maziggy/bambuddy). It is not the official project.**

Bambuddy is a self-hosted management tool for Bambu Lab printers, created by [maziggy](https://github.com/maziggy). All of its core functionality comes from the upstream project. This fork only adds a few quality-of-life tweaks for my own print farm, and keeps following upstream.

## Upstream

| | |
|---|---|
| Source | <https://github.com/maziggy/bambuddy> |
| Documentation | <https://wiki.bambuddy.cool> |
| Website | <https://bambuddy.cool> |
| Issues | <https://github.com/maziggy/bambuddy/issues> |
| Support the author | [GitHub Sponsors](https://github.com/sponsors/maziggy) · [Ko-fi](https://ko-fi.com/maziggy) |

For features, installation and usage, refer to upstream. If Bambuddy is useful to you, please support the upstream author.

**Please do not report problems with this fork upstream.** First check whether the problem also happens on the official release. If it does, report it upstream. If it only happens on this fork, it has nothing to do with upstream.

## What's changed

Each change is kept as a self-contained patch, with its code under directories named `hyyz17200`. Upstream files are touched as little as possible so the fork can keep up with upstream.

- **In-app updater locked**: the one-click update resets the code to an upstream release, which would drop this fork's patches, so the install button is disabled. Checking for updates still works.
- **Hide chosen fault codes** (upstream [#3269](https://github.com/maziggy/bambuddy/issues/3269)): pick HMS fault codes you don't want to see. Hidden faults don't count toward badges and don't send notifications. They are still recorded in full and shown collapsed in the error dialog.
- **Camera wall keeps the last frame**: when a snapshot refresh is slow or fails, the tile keeps showing the previous frame instead of going black or getting stuck on "No signal". The backend caches the last good frame for each printer so requests return immediately, and the number of live streams can be set to 0.
- **Stop taking jobs**: a printer card menu entry that keeps the queue from sending the printer new jobs, without maintenance mode's disconnect. A running print finishes and is recorded, every control keeps working, and the printer keeps its location. Jobs for "any printer" go to other printers; jobs pinned to it wait. The card shows a yellow dot (S) or a yellow pill and Print button (M and larger), and Print offers to resume first.
- **Wide screen layout**: on wide screens (≥1536px), printer cards and the camera wall fit more per row, with an adjustable maximum and minimum width. Narrower screens keep the upstream layout.
- **Enhanced settings page**: a new "Enhanced settings" sidebar entry that collects the settings for all of the above.

If upstream implements the same feature, this fork drops its own version and uses upstream's.

## Getting it

This fork publishes pre-releases on [Releases](https://github.com/hyyz17200/bambuddy/releases) only:

- **Windows installer**: `bambuddy-<tag>-windows-x64-setup.exe`. It is unsigned; if SmartScreen blocks it, choose "More info → Run anyway".
- **Docker image**: `ghcr.io/hyyz17200/bambuddy:<tag>`. `:hyyz17200` always points to the latest release. linux/amd64 only.

Docker usage is the same as upstream. In upstream's `docker-compose.yml`, change `image:` to this fork's image and remove `build: .`:

```yaml
services:
  bambuddy:
    image: ghcr.io/hyyz17200/bambuddy:hyyz17200
    # everything else as in upstream's docker-compose.yml
```

Back up your data before switching from an upstream release. Since in-app updates are disabled, upgrade by downloading a new installer or pulling a new image.

## Branches

| Branch | Contents |
|---|---|
| `dev` | Clean mirror of upstream `dev`, no changes |
| `hyyz17200` | `dev` plus this fork's patches; releases are built from here |

The patches are always rebased on top of upstream, so `git log dev..hyyz17200` shows every change this fork makes.

## License

Like upstream, this fork is released under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

- Upstream code is copyright the original Bambuddy author and contributors. This fork keeps upstream's license and copyright notices.
- This fork's changes are also released under AGPL-3.0, with full source at <https://github.com/hyyz17200/bambuddy>.
- If you redistribute this fork, or run it as a network service for others, AGPL-3.0 applies to you as well, including providing the corresponding source to your users.

## Acknowledgments

Thanks to [maziggy](https://github.com/maziggy) and all Bambuddy contributors for their excellent work. Everything in this fork is built on the upstream project.
