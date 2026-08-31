# Installing on a machine with nothing on it

Verified, not assumed: a bare Alpine 3.24 LXC container, 1 core, 512 MB of
memory, 2 GB of disk, network and nothing else. No Node, no curl, no API key.

```bash
wget -qO- https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
```

That is the whole of it. The script installs Node and the runtime packages,
downloads the release, fetches the data, creates the service user, writes the
service and starts it. It ends with the number of trains it is tracking, which
is the useful confirmation — an install that gets that far is working.

## What it reaches for

Fourteen things, all public, none needing an account:

| what                        | from                                    |
| --------------------------- | --------------------------------------- |
| the installer               | raw.githubusercontent.com               |
| the release, by tag         | api.github.com, then the release asset  |
| the application             | `traincon.tar.gz` on the release        |
| signal positions            | `signals.json.gz` on the release        |
| Node and system packages    | the distribution's own repositories     |
| runtime dependencies        | the npm registry                        |
| rail geometry, line speeds, block modes | SNCF Réseau open data       |

And, in the browser rather than at install time: MapLibre from unpkg, the
basemap from CARTO, and the surveyed track tiles from carto.tchoo.net.

## What it does not need

* **No API key.** The schedule, the real-time feed and the geometry are all
  open data. A key adds disruption reasons and station boards; without one the
  installer says so and carries on.
* **No curl.** The documented one-liner uses it, but a minimal Alpine does not
  ship it — hence the `wget` form above, which busybox provides.
* **No build step.** The release carries the built client and server. The
  artwork — six vehicle drawings, four signal drawings, the icons — is inlined
  into the bundle, so there are no separate asset files to go missing.

## Room to run

Measured on the clean install above, tracking 1 089 trains:

| disk after install | ~120 MB, of which 29 MB is the geometry |
| heap               | 86 MB against a 281 MB ceiling          |

The heap ceiling is set from the container's own memory limit, so a smaller
machine gets a smaller ceiling rather than an out-of-memory kill. Production
runs in 512 MB with a 1 GB disk.

## Updating

The same command. `data/` is preserved, so the geometry is not downloaded
again; the signal positions are refreshed every time, being small and pinned
to the release.
