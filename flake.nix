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

        # Cargo.toml stays 0.0.0 in git so release/CI can stamp a tag into it.
        # Pure NixOS rebuilds never see that CI working tree, so ./VERSION is
        # what source builds read. Release automation writes it when tagging;
        # 0.0.0 means unreleased → same 0.0.0-<N> scheme as dev-version.sh.
        commit = pkgs.lib.removeSuffix "-dirty" (self.rev or self.dirtyRev or "0000000");
        releaseVersion = pkgs.lib.removeSuffix "\n" (builtins.readFile ./VERSION);
        version =
          if releaseVersion == "0.0.0" then
            "0.0.0-${toString (pkgs.lib.fromHexString (builtins.substring 0 4 commit))}"
          else
            releaseVersion;

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
          ruff
          nodejs_26
          pnpm
        ];

        runtimeLibs = with pkgs; [
          libappindicator-gtk3
          libayatana-appindicator
        ];

        devShell = pkgs.mkShell {
          buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux linuxBuildInputs;
          inherit nativeBuildInputs;

          shellHook = ''
            ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}:$LD_LIBRARY_PATH"
            ''}
            echo "LG TV Remote development environment"
            echo ""
            echo "Commands:"
            echo "  cargo tauri dev    - Run in development mode"
            echo "  cargo tauri build  - Build for production"
            echo "  ./scripts/macos-build.sh - macOS production build with a stable signing identity"
            echo "  cargo outdated     - Check for outdated dependencies"
            echo "  ./generate-icons.sh - Generate icon files"
            echo "  pnpm lint          - Lint JS/TS, Python, and Rust"
            echo "  pnpm format:js     - Format JS/TS with Biome"
            echo "  pnpm format:py     - Format Python with Ruff"
            echo "  pnpm format:rust   - Format Rust with rustfmt"
            echo ""
            ${pkgs.lib.optionalString (!pkgs.stdenv.hostPlatform.isLinux) ''
              echo "Note: nix build .#default is Linux-only. On macOS use ./scripts/macos-build.sh."
              echo ""
            ''}
          '';

          WEBKIT_DISABLE_COMPOSITING_MODE = "1";
        };

        trayPackage = pkgs.rustPlatform.buildRustPackage {
          pname = "lgtv-tray-remote";
          inherit version;

          src = ./.;

          # The window reads CARGO_PKG_VERSION from Cargo.toml. Stamp the dev
          # version into the sources that get compiled; do not commit it.
          # Leave Cargo.lock unchanged here. cargoSetupPostPatchHook requires it
          # to match the vendored lock, which still says 0.0.0.
          postPatch = ''
            sed -i 's/^version = ".*"/version = "${version}"/' src-tauri/Cargo.toml
            sed -i 's/"version": "[^"]*"/"version": "${version}"/' src-tauri/tauri.conf.json
          '';

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

            # The vendored-lock check has already passed. Record the same version
            # cargo is about to compile so the lock matches Cargo.toml.
            sed -i '/^name = "lgtv-tray-remote"$/{n;s/^version = .*/version = "${version}"/}' src-tauri/Cargo.lock

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

        packages = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          default = trayPackage;
        };

        apps = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          default = {
            type = "app";
            program = "${trayPackage}/bin/lgtv-tray-remote";
          };
        };
      }
    );
}
