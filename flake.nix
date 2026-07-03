{
  description = "LG TV Remote - Cross-platform system tray application";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" ];
        };

        # Linux-only GTK/WebKit deps (webkitgtk is marked broken on Darwin in nixpkgs)
        linuxBuildInputs = with pkgs; [
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          dbus
          openssl
          librsvg
          libappindicator-gtk3
          noto-fonts-color-emoji
        ];

        nativeBuildInputs = with pkgs; [
          rustToolchain
          pkg-config
          librsvg
          imagemagick
          cargo-tauri
          cargo-outdated
        ];

        runtimeLibs = with pkgs; [
          libappindicator-gtk3
          libayatana-appindicator
        ];

        devShell = pkgs.mkShell {
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux linuxBuildInputs;
          inherit nativeBuildInputs;

          shellHook = ''
            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}:$LD_LIBRARY_PATH"
            ''}
            echo "LG TV Remote development environment"
            echo ""
            echo "Commands:"
            echo "  cargo tauri dev    - Run in development mode"
            echo "  cargo tauri build  - Build for production"
            echo "  cargo outdated     - Check for outdated dependencies"
            echo "  ./generate-icons.sh - Generate icon files"
            echo ""
            ${pkgs.lib.optionalString (!pkgs.stdenv.isLinux) ''
              echo "Note: nix build .#default is Linux-only. On macOS use cargo tauri build."
              echo ""
            ''}
          '';

          WEBKIT_DISABLE_COMPOSITING_MODE = "1";
        };

        trayPackage = pkgs.rustPlatform.buildRustPackage {
          pname = "lgtv-tray-remote";
          version = "0.0.0";

          src = ./.;

          cargoRoot = "src-tauri";
          buildAndTestSubdir = "src-tauri";

          cargoLock = {
            lockFile = ./src-tauri/Cargo.lock;
          };

          nativeBuildInputs = with pkgs; [
            pkg-config
            cargo-tauri
            makeWrapper
            copyDesktopItems
            fontconfig
            dejavu_fonts
            gsettings-desktop-schemas
          ];

          buildInputs = linuxBuildInputs;

          # Skip default cargo build, use tauri instead
          buildPhase = ''
            runHook preBuild

            cd src-tauri
            cargo tauri build --no-bundle
            cd ..

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/bin $out/share/applications $out/share/icons/hicolor/128x128/apps

            cp src-tauri/target/release/lgtv-tray-remote $out/bin/
            cp src-tauri/icons/128x128.png $out/share/icons/hicolor/128x128/apps/lgtv-tray-remote.png

            cat > $out/share/applications/lgtv-tray-remote.desktop << EOF
[Desktop Entry]
Name=LG TV Remote
Comment=Control your LG webOS TV
Exec=$out/bin/lgtv-tray-remote
Icon=lgtv-tray-remote
Type=Application
Categories=Utility;
EOF

            wrapProgram $out/bin/lgtv-tray-remote \
              --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath (linuxBuildInputs ++ runtimeLibs)}" \
              --set WEBKIT_DISABLE_COMPOSITING_MODE 1 \
              --set WEBKIT_DISABLE_DMABUF_RENDERER 1 \
              --set TAURI_AUTOSTART_EXEC lgtv-tray-remote \
              --prefix XDG_DATA_DIRS : "/run/current-system/sw/share" \
              --prefix XDG_DATA_DIRS : "${pkgs.dejavu_fonts}/share" \
              --prefix XDG_DATA_DIRS : "${pkgs.noto-fonts-color-emoji}/share" \
              --prefix XDG_DATA_DIRS : "${pkgs.hicolor-icon-theme}/share" \
              --prefix XDG_DATA_DIRS : "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}" \
              --prefix GIO_EXTRA_MODULES : "${pkgs.glib-networking}/lib/gio/modules"

            runHook postInstall
          '';

          # Tauri embeds the frontend, no separate check needed
          doCheck = false;
        };

      in {
        devShells.default = devShell;

        packages = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          default = trayPackage;
        };

        apps = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          default = {
            type = "app";
            program = "${trayPackage}/bin/lgtv-tray-remote";
          };
        };
      }
    );
}
