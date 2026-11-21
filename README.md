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
- **Camera wall capture concurrency**: in Enhanced settings, choose how many printers the camera wall takes snapshots from at the same time (1–16, default 2 as before). On a large wall each snapshot tile refreshes about every (snapshot printers × time per capture ÷ captures at once), so raising it refreshes the tiles sooner.
- **More than 16 live streams**: upstream stops the camera wall's "Max live streams" at 16. In Enhanced settings you can raise that limit up to 256 for a big wall on a big screen. Each live tile keeps its own connection, so over plain HTTP the browser's 6-connections-per-server limit still applies; serve Bambuddy over HTTPS (HTTP/2) for many live tiles.
- **Stop taking jobs**: a hand button left of the camera button on the printer card (and the same entry in the card menu) that keeps the queue from sending the printer new jobs, without maintenance mode's disconnect. A running print finishes and is recorded, every control keeps working, and the printer keeps its location. Jobs for "any printer" go to other printers; jobs pinned to it wait. The card shows a yellow dot (S) or a yellow pill, hand button and Print button (M and larger). One tap on the hand button stops; resuming from it or from Print asks first.
- **Move to location from the card**: the printer card's menu has "Move to location", which shows every location as a tile (with its icon, color and printer count). One tap moves the printer; there is also "No location" and a new location typed in. Big enough for touch screens.
- **More bulk actions on the printers page**: the multi-select toolbar can also move printers to a location (including a new one), enter or leave maintenance, stop or resume taking jobs, force a status refresh, set or reset the external spool on every selected printer through the usual slot dialog (each printer keeps its own K value of the same name), and export the printer information of the selection as CSV. Each change is confirmed first and lists the printers it touches.
- **Batch calibration**: a "Calibrate" button on the multi-select toolbar runs the printer's own calibration (bed leveling, vibration compensation, motor noise cancellation) on the selected printers one at a time, shelf by shelf: the next starts only after the last one is idle again, so neighbouring printers don't shake each other. Motor noise cancellation is only sent to printers that report supporting it. Whether a printer takes jobs is left as it is; the queue just sends it nothing until its own calibration is over. A printer still waiting for its plate-clear confirmation when its turn comes is skipped, and a completed calibration doesn't ask for "Clear plate". The batch survives a Bambuddy restart; it refuses to start while upstream's unauthorized-print kill switch is on, which would stop the calibration.
- **Wide screen layout**: on wide screens (≥1536px), printer cards and the camera wall fit more per row, with an adjustable maximum and minimum width. Narrower screens keep the upstream layout.
- **Your own quick colors**: the color swatches under "Custom color" in the AMS slot dialog and in the spool form can be replaced with your own list, shared by both dialogs and every browser. Until you turn it on, each dialog keeps upstream's colors.
- **RGB color input**: the AMS slot dialog has R, G and B boxes (0–255) under the color field. They follow the hex or color name typed above, and editing them updates it.
- **Slice as designed, in bulk**: select 3MF projects in the File Manager and click "Slice as designed". Each one is sliced with the printer, process and filament settings saved in the file, exactly as set up in the slicer, without picking presets, and works with custom printer presets that upstream's "Use the file's built-in settings" won't offer. Files are sliced one at a time in the background, and each result is saved as `.gcode.3mf` next to its source. A panel shows progress, lets you stop after the current file, and lists any file that failed or was skipped, with the reason.
- **Bulk add printers**: a "Bulk add" button next to Add Printer opens an editable table. Scan a subnet (up to a /16; upstream's scan stops at 1024 addresses) and every printer found joins the table with its IP, serial number, name and model (also A1/P1, which upstream's subnet scan shows as "unknown serial"), leaving only the access codes to type (Enter moves down the column). Or load or paste a CSV (name, IP, access code, model, location; header names in English or Chinese): it is matched by IP, so a CSV of IPs and access codes completes a scanned table, and missing serial numbers are read from each printer by its IP. Rows with a problem (missing field, duplicate, already added) are marked before anything is saved. The printers are then added one at a time through upstream's Add Printer route, skipping its connection test by default; the table shows whether each printer connects afterwards.
- **Auto unload after a long idle**: when a printer has sat idle or finished for a set time (5–720 minutes, default 30; off until you turn it on in Enhanced settings), its filament is unloaded back into the AMS, the same as clicking unload on the slot. Handy when your end G-code leaves the filament in the toolhead between jobs and you want to take the spools out afterwards. Before unloading, the printer is asked for a full status refresh, and nothing is sent unless the same slot is still loaded. The external spool, dual-nozzle printers, failed prints and printers with a fault showing, a busy or drying AMS, a queue job on its way or a calibration batch are left alone, and the queue sends the printer nothing while it unloads. Each idle stretch gets one try. The same settings tab lists every printer with why it is or is not being unloaded (waiting, nothing loaded, fault showing, AMS busy, …) and how its last unload went; works with AMS Lite and a BMCU in either mode.
- **Prefer the loaded slot**: when several AMS slots hold the same spool (two slots set up for AMS filament backup, say), the queue takes the one already loaded in the toolhead instead of the lowest-numbered one, so the print starts without a filament change and one spool is used up before the next. With nothing loaded (after an unload) it takes the slot loaded last, remembered across restarts. A slot is only swapped for one with the same material, colour and filament preset, so a job never gets a different filament. Applies to every queue job and to maintenance G-code; off until you turn it on in Enhanced settings, and left to "Prefer lowest remaining filament" on printers where that applies.
- **Send maintenance G-code from the card**: pick a File Manager folder in Enhanced settings, then use "Send maintenance G-code" in a printer card's menu. It lists the sliced files (`.gcode.3mf`) in that folder and its subfolders that were sliced for the printer's model; the one you pick is sent at once, even when the printer is not taking jobs and ahead of anything waiting in the queue. By default the printer then stops taking jobs (untick it in the dialog to keep it as it was). Calibrations, timelapse and G-code injection are off, and the AMS mapping is matched automatically (sent without one when nothing matches). It stays out of the plate-clear confirmation: a printer waiting for "Clear plate" is refused, and a completed maintenance job doesn't ask for it. It counts like any other print. What the G-code does is up to the file.
- **Printer notes**: "Notes…" in a printer card's menu keeps notes on that printer, of three kinds: a standing note ("0.6 mm nozzle fitted"), a to-do ("Z axis squeaks"), and done (a to-do marked done, or something logged as already done). Every card size, the smallest included, shows a marker next to the printer's name: blue with the number of to-dos, or a grey icon when there are only standing notes. Click it to open the notes. The history lists the done notes together with the printer's maintenance resets from the Maintenance page, newest first. Uses the maintenance permissions.
- **Plate-clear confirmation for the whole farm**: upstream lets each printer follow the app's "Require plate clear" setting or have its own, but only one printer at a time in Edit Printer. Enhanced settings lists every printer with its setting and whether the confirmation applies, filters by model and location, and sets many at once.
- **Printer counts in the tab title**: instead of one print's progress, the browser tab can show how many printers are printing, paused, finished, idle, with a problem or offline, or in total, for example "▶12 ⏸1 ✓5 ⚠2 ✕3 · Bambuddy". Choose the counts, their order and the label in front of each number in Enhanced settings; zeros can be left out. The counts match the status bar on the Printers page, and hidden fault codes don't count. Off until you turn it on.
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
