# LG TV Remote - KDE Plasma 6 Widget

A simple Plasma 6 widget to control your LG webOS TV from your desktop.

## Features

- Power on/off your TV
- Navigation controls (arrow keys, OK, back, home)
- Volume controls with mute toggle
- Keyboard shortcuts when widget is focused
- SSL support for newer TV firmware

## Requirements

- KDE Plasma 6
- Python 3 with `websockets` module

## Installation

### NixOS

```bash
# Enter development shell (has all dependencies)
nix develop

# Install widget
./install.sh

# Test in a window (install + run plasmawindowed)
./dev
```

Or add to your system configuration:
```nix
environment.systemPackages = [
  (python3.withPackages (ps: [ ps.websockets ]))
];
```

### Other Distros

```bash
# Install websockets
pip install --user websockets

# Install widget
./install.sh
```

Or manually:
```bash
kpackagetool6 -t Plasma/Applet -i ./package
```

**After reinstalling or updating:** If the widget is already on your panel and looks unchanged, Plasma is still using the old copy in memory. Remove the widget (right‑click → Remove), then add it again from Add Widgets, or log out and back in.

## First Time Setup

1. Add the widget to your panel or desktop
2. Enter a name for your TV (e.g., "LivingRoomTV")
3. Enter your TV's IP address (find it in TV Settings > Network)
4. Check "Use SSL" (required for newer firmware)
5. Click "Auth" and accept the pairing request on your TV screen

## Keyboard Shortcuts

When the widget popup is focused:
- **Arrow Keys**: Navigation
- **Enter**: OK/Select
- **Backspace/Escape**: Back
- **=**: Volume Up
- **-**: Volume Down

## Uninstall

```bash
./uninstall.sh
# or
kpackagetool6 -t Plasma/Applet -r com.codekitties.lgtv.remote
```

## Project Structure

```
plasmoid/
├── install.sh              # Installation script
├── uninstall.sh            # Uninstallation script
├── README.md               # This file
└── package/                # The actual widget package
    ├── metadata.json       # Widget metadata
    └── contents/
        ├── ui/main.qml     # Main QML interface
        ├── config/main.xml # Configuration schema
        ├── icons/icon.svg  # Widget icon
        └── code/           # Bundled Python script
            └── lgtv_remote.py
```

## License

MIT
