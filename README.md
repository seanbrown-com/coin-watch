# Coin Watch

A small local web app for monitoring one or more solo.ckpool.org Bitcoin miners in plain English.

## Run

```sh
npm start
```

Then open:

```text
http://localhost:4173
```

The app stores your saved miners in the browser's `localStorage`. It uses a tiny Node server because CKPool's public JSON endpoint does not include browser CORS headers.

## What It Shows

- Whether each miner is active or stale.
- Current 5-minute hashrate, plus 1-hour, 1-day, and 7-day context.
- Time since the last submitted share.
- Best share progress compared with current Bitcoin network difficulty.
- Simple daily odds and average expected wait at the current hashrate.

Solo mining progress is not cumulative. The best share is the closest attempt so far; every new share is still an independent chance to solve a block.

## Update on an LXC

For a first-time install inside a Debian/Ubuntu LXC, run as root:

```sh
REPO_URL=https://github.com/seanbrown-com/coin-watch.git bash scripts/install-lxc.sh
```

This installs required packages, checks out the app to `/opt/coin-watch`, creates a `coin-watch` system user, writes a systemd service, and starts the app on port `8002`.

If the app is deployed as a git checkout and managed by systemd, use:

```sh
./scripts/update-service.sh
```

Defaults:

- App directory: `/opt/coin-watch`
- systemd service: `coin-watch`
- Branch: `main`

Override them when needed:

```sh
APP_DIR=/srv/coin-watch SERVICE_NAME=coin-watch BRANCH=main ./scripts/update-service.sh
```
