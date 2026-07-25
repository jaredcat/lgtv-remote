# LG TV Remote (Decky Plugin)

Control an LG webOS TV from Steam Deck via [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader).

Shares the same WebSocket protocol as the tray app and KDE plasmoid in this repo.

## Features

- Pair / authenticate with your TV
- D-pad, Home, Back
- Media controls (play, pause, stop, rewind, fast forward)
- Volume up/down, mute/unmute
- Power off (while connected)
- Power on via Wake-on-LAN (after pairing saves MAC)

## Prerequisites

- Decky Loader installed on your Steam Deck
- TV and Deck on the same network
- Node.js 16+ and pnpm 9 on your dev machine

## Setup (development)

```bash
cd decky

# Frontend deps
pnpm install

# Python websockets dep (required on the Deck)
pip install websockets -t py_modules --no-deps

# Build frontend
pnpm run build
```

Deploy to your Deck:

```bash
chmod +x deploy.sh
./deploy.sh deck@10.0.1.63
```

Or manually after `pnpm run build`:

```bash
scp -r dist main.py plugin.json package.json py py_modules deck@10.0.1.63:~/homebrew/plugins/lgtv-remote-decky/
```

### Permission denied on deploy?

Decky often installs plugins as **root**, so normal `rm`/`mv` cannot replace them. `deploy.sh` uses `sudo` for install and will prompt for your **deck** sudo password once.

To fix ownership for the whole homebrew tree (optional, one-time):

```bash
ssh -tt deck@10.0.1.63 'sudo chown -R deck:deck ~/homebrew'
```

To avoid typing your SSH password every step, add an SSH key:

```bash
ssh-copy-id deck@10.0.1.63
```

Then reload plugins in Decky, or restart Decky Loader.

## Usage

1. Open the plugin from the Decky quick-access menu (⋯ button).
2. Enter **TV IP** (find it in TV Settings → Network).
3. Tap **Save settings**.
4. Tap **Authenticate** and accept the pairing prompt on the TV.
5. Tap **Connect**.
6. Use the remote sections to control the TV.

**Power On** uses Wake-on-LAN and requires the TV to have been paired while powered on (so the MAC address is saved). Enable Wake-on-LAN in the TV's network settings.

## Project layout

```
decky/
  main.py          # Decky plugin entry (RPC handlers)
  py/tv.py         # LG webOS WebSocket client
  py_modules/      # Vendored Python deps (websockets)
  src/index.tsx    # React UI
  plugin.json      # Decky metadata
```

## Building for distribution

```bash
pnpm run build
```

Zip the plugin per [Decky distribution layout](https://github.com/SteamDeckHomebrew/decky-plugin-template#distribution): include `dist/`, `main.py`, `plugin.json`, `package.json`, `py/`, `py_modules/`, and `LICENSE`.

## License

MIT — see [../LICENSE](../LICENSE).
