# LG TV Remote - Cross-Platform Tray App

A system tray application for controlling LG webOS TVs. Works on **Windows**, **macOS**, and **Linux**.

![Screenshot](screenshot.png)

## Features

- System tray icon with popup remote control
- D-pad navigation (Up, Down, Left, Right, OK)
- Volume control (Up, Down, Mute, Unmute)
- Power On (Wake-on-LAN) and Power Off
- Home and Back buttons
- Keyboard shortcuts
- Auto-reconnect on startup
- **Start with computer** (autostart at login) — option in Settings
- Persistent TV configuration

## Installation

### NixOS / Nix

**Enable binary cache** (recommended - avoids building from source):
```bash
# One-time setup
nix run nixpkgs#cachix -- use lgtv-tray-remote
```

Or add to your NixOS configuration:
```nix
nix.settings = {
  substituters = [ "https://lgtv-tray-remote.cachix.org" ];
  trusted-public-keys = [ "lgtv-tray-remote.cachix.org-1:no3KeuRIc/+Msy8eQLsIVy29FZ85KI2GC6/jJkMMrvg=" ];
};
```

**Run directly** (no install):
```bash
nix run github:jaredcat/plasmoid-lgtv-remote?dir=lgtv-tray-remote
```

**Install to profile**:
```bash
nix profile install github:jaredcat/plasmoid-lgtv-remote?dir=lgtv-tray-remote
```

**Add to NixOS configuration** (flake-based):
```nix
# flake.nix
{
  inputs.lgtv-remote.url = "github:jaredcat/plasmoid-lgtv-remote?dir=lgtv-tray-remote";
}

# configuration.nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.lgtv-remote.packages.${pkgs.system}.default
  ];
}
```

**Build locally**:
```bash
cd lgtv-tray-remote
nix build
./result/bin/lgtv-tray-remote
```

### Pre-built Binaries

Download from the [Releases](https://github.com/jaredcat/plasmoid-lgtv-remote/releases) page:

- **Windows**: `lgtv-tray_x.x.x_x64-setup.exe` or `.msi`
- **macOS**: `lgtv-tray_x.x.x_aarch64.dmg` (Apple Silicon) or `lgtv-tray_x.x.x_x64.dmg` (Intel)
- **Linux**: `lgtv-tray_x.x.x_amd64.AppImage` or `.deb`

#### macOS: Removing Quarantine

Since the app isn't signed with an Apple Developer certificate, macOS Gatekeeper will block it. After installing, run:

```bash
xattr -cr "/Applications/LG TV Remote.app"
```

Then you can open the app normally.

### Build from Source

#### Using Nix (Recommended)

If you have Nix with flakes enabled:

```bash
cd lgtv-tray-remote

# Enter development shell with all dependencies
nix develop

# Generate icons and build
./generate-icons.sh
cargo tauri build
```

#### Manual Setup

##### Prerequisites

1. **Rust** (1.70+): https://rustup.rs/
2. **Tauri CLI**:
   ```bash
   cargo install tauri-cli
   ```

4. **Platform-specific dependencies**:

   **Linux (Debian/Ubuntu)**:
   ```bash
   sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
   ```

   **Linux (Fedora)**:
   ```bash
   sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel
   ```

   **Linux (Arch)**:
   ```bash
   sudo pacman -S webkit2gtk-4.1 libappindicator-gtk3 librsvg
   ```

   **macOS**: Xcode Command Line Tools
   ```bash
   xcode-select --install
   ```

   **Windows**: [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

#### Generate Icons

Before building, generate the required icon files:

```bash
chmod +x generate-icons.sh
./generate-icons.sh
```

This requires one of: `librsvg` (rsvg-convert), `inkscape`, or `imagemagick`.

#### Build

```bash
# Development (with hot reload)
cargo tauri dev

# Production build
cargo tauri build
```

Build outputs are in `src-tauri/target/release/bundle/`.

## Usage

### First Time Setup

1. Launch the app - it will appear in your system tray
2. Click the tray icon to open the remote
3. Expand **Settings** and enter:
   - **TV Name**: A friendly name (e.g., "LivingRoom")
   - **TV IP**: Your TV's IP address (find it in TV Settings > Network)
   - **Use SSL**: Leave checked (recommended)
4. Click **Authenticate**
5. **Accept the pairing prompt on your TV screen**
6. You're connected!

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow keys | Navigate |
| Enter | Select/OK |
| Backspace/Escape | Back |
| `+` | Volume Up |
| `-` | Volume Down |
| Shift + `=` | Unmute |
| Shift + `-` | Mute |

### Power On (Wake-on-LAN)

For **Power On** to work:
1. Enable "Wake on LAN" in your TV's network settings
2. The TV must have been authenticated at least once while powered on (to save its MAC address)
3. Your computer must be on the same network as the TV

### Configuration

Settings are stored in:
- **Linux**: `~/.config/lgtv-remote/config.json`
- **macOS**: `~/Library/Application Support/lgtv-remote/config.json`
- **Windows**: `%APPDATA%\lgtv-remote\config.json`

## Troubleshooting

### Power On not working
- The saved MAC address might be incorrect
- Try manually setting the MAC address from the settings in the TV

### "MAC address not saved" (Power On fails)
- Power on the TV manually
- Re-authenticate using the Settings panel
- The app will save the MAC address for future Wake-on-LAN

### Connection drops frequently
- Some TVs close WebSocket connections after inactivity
- The app will auto-reconnect when you send a command


### "Connection timeout"
- Verify the TV IP address is correct
- Ensure your computer and TV are on the same network
- Check if the TV is powered on

### "Registration timeout - check TV for pairing prompt"
- Look at your TV screen for the pairing dialog
- Accept the connection request within 60 seconds

## Development

### Cross-Compilation

Build for other platforms:

```bash
# From Linux, target Windows (requires cross-compilation setup)
cargo tauri build --target x86_64-pc-windows-msvc

# Build for specific Linux target
cargo tauri build --target x86_64-unknown-linux-gnu
```

See [Tauri Cross-Compilation Guide](https://tauri.app/v1/guides/building/cross-platform) for details.

## License

MIT
