# LG TV Remote Apps

Control your LG webOS TV directly from your desktop.

![License](https://img.shields.io/badge/License-MIT-green)

## Choose Your Version

| Version | Platform | Description |
|---------|----------|-------------|
| **[KDE Plasma Widget](plasmoid/)** | KDE Plasma 6 (Linux) | Native panel widget integrated with Plasma |
| **[Tray App](tray/)** | Windows, macOS, Linux | Cross-platform system tray application |

## Features

- **Power Control**: Turn your TV on (Wake-on-LAN) and off
- **Navigation**: D-pad controls for menu navigation
- **Volume**: Volume up/down and mute/unmute
- **Keyboard Shortcuts**: Control your TV with keyboard
- **Quick Access**: Home, Back buttons

## Quick Links

- **KDE Users**: See [plasmoid/README.md](plasmoid/README.md)
- **Windows/macOS/Other Linux**: See [tray/README.md](tray/README.md)
- **Releases**: [GitHub Releases](https://github.com/jaredcat/plasmoid-lgtv-remote/releases)

## Development

Each version has its own development environment:

```bash
# KDE Plasma Widget
cd plasmoid && nix develop

# Cross-platform Tray App
cd tray && nix develop
```

## License

MIT License

## Credits

- Protocol based on [LGWebOSRemote](https://github.com/klattimer/LGWebOSRemote)
