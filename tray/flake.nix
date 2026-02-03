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

        # Common build inputs for Tauri
        buildInputs = with pkgs; [
          # Tauri dependencies
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          dbus
          openssl
          librsvg

          # For system tray
          libappindicator-gtk3

          # Emoji font so UI emoji render consistently on NixOS
          noto-fonts-color-emoji
        ];

        nativeBuildInputs = with pkgs; [
          rustToolchain
          pkg-config

          # For icon generation
          librsvg
          imagemagick

          # Tauri CLI
          cargo-tauri

          # Check for outdated dependencies
          cargo-outdated
        ];

        # Runtime library path for system tray
        runtimeLibs = with pkgs; [
          libappindicator-gtk3
          libayatana-appindicator
        ];

      in {
        devShells.default = pkgs.mkShell {
          inherit buildInputs nativeBuildInputs;

          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}:$LD_LIBRARY_PATH"
            echo "LG TV Remote development environment"
            echo ""
            echo "Commands:"
            echo "  cargo tauri dev    - Run in development mode"
            echo "  cargo tauri build  - Build for production"
            echo "  cargo outdated     - Check for outdated dependencies"
            echo "  ./generate-icons.sh - Generate icon files"
            echo ""
          '';

          # Required for Tauri
          WEBKIT_DISABLE_COMPOSITING_MODE = "1";
        };

        packages.default = pkgs.rustPlatform.buildRustPackage {
          pname = "lgtv-tray-remote";
          version = "1.3.0";

          src = ./.;

          cargoRoot = "src-tauri";
          buildAndTestSubdir = "src-tauri";

          cargoLock = {
            lockFile = ./src-tauri/Cargo.lock;
          };

          nativeBuildInputs = with pkgs; [
            pkg-config
            cargo-tauri
            librsvg
            imagemagick
            makeWrapper
            copyDesktopItems
            fontconfig
            dejavu_fonts
            gsettings-desktop-schemas
          ];

          inherit buildInputs;

          postPatch = ''
            patchShebangs generate-icons.sh
          '';

          preBuild = ''
            # Generate icons
            ./generate-icons.sh
          '';

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
              --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath (buildInputs ++ runtimeLibs)}" \
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

        # Quick run without full install
        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/lgtv-tray-remote";
        };
      }
    );
}
