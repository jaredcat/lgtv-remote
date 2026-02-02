#!/bin/bash
# Generate PNG icons from SVG for Tauri
# Requires: inkscape, imagemagick, or librsvg

set -e

ICON_DIR="src-tauri/icons"
SVG_FILE="$ICON_DIR/icon.svg"

echo "Generating icons from $SVG_FILE..."

# Check for available tools
if command -v rsvg-convert &> /dev/null; then
    echo "Using rsvg-convert..."
    rsvg-convert -w 32 -h 32 "$SVG_FILE" -o "$ICON_DIR/32x32.png"
    rsvg-convert -w 128 -h 128 "$SVG_FILE" -o "$ICON_DIR/128x128.png"
    rsvg-convert -w 256 -h 256 "$SVG_FILE" -o "$ICON_DIR/128x128@2x.png"
    rsvg-convert -w 256 -h 256 "$SVG_FILE" -o "$ICON_DIR/icon.png"
elif command -v inkscape &> /dev/null; then
    echo "Using inkscape..."
    inkscape -w 32 -h 32 "$SVG_FILE" -o "$ICON_DIR/32x32.png"
    inkscape -w 128 -h 128 "$SVG_FILE" -o "$ICON_DIR/128x128.png"
    inkscape -w 256 -h 256 "$SVG_FILE" -o "$ICON_DIR/128x128@2x.png"
    inkscape -w 256 -h 256 "$SVG_FILE" -o "$ICON_DIR/icon.png"
elif command -v convert &> /dev/null; then
    echo "Using ImageMagick..."
    convert -background none -resize 32x32 "$SVG_FILE" "$ICON_DIR/32x32.png"
    convert -background none -resize 128x128 "$SVG_FILE" "$ICON_DIR/128x128.png"
    convert -background none -resize 256x256 "$SVG_FILE" "$ICON_DIR/128x128@2x.png"
    convert -background none -resize 256x256 "$SVG_FILE" "$ICON_DIR/icon.png"
else
    echo "Error: No SVG converter found. Install one of: librsvg, inkscape, imagemagick"
    exit 1
fi

# Generate Windows .ico
if command -v magick &> /dev/null; then
    echo "Generating Windows .ico..."
    magick "$ICON_DIR/32x32.png" "$ICON_DIR/128x128.png" "$ICON_DIR/128x128@2x.png" "$ICON_DIR/icon.ico"
elif command -v icotool &> /dev/null; then
    icotool -c -o "$ICON_DIR/icon.ico" "$ICON_DIR/32x32.png" "$ICON_DIR/128x128.png"
else
    echo "Warning: Cannot generate .ico (install imagemagick or icoutils)"
fi

# Generate macOS .icns (requires iconutil on macOS or png2icns on Linux)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Generating macOS .icns..."
    ICONSET="$ICON_DIR/icon.iconset"
    mkdir -p "$ICONSET"
    cp "$ICON_DIR/32x32.png" "$ICONSET/icon_32x32.png"
    cp "$ICON_DIR/128x128.png" "$ICONSET/icon_128x128.png"
    cp "$ICON_DIR/128x128@2x.png" "$ICONSET/icon_128x128@2x.png"
    rsvg-convert -w 16 -h 16 "$SVG_FILE" -o "$ICONSET/icon_16x16.png" 2>/dev/null || true
    rsvg-convert -w 256 -h 256 "$SVG_FILE" -o "$ICONSET/icon_256x256.png" 2>/dev/null || true
    rsvg-convert -w 512 -h 512 "$SVG_FILE" -o "$ICONSET/icon_512x512.png" 2>/dev/null || true
    iconutil -c icns "$ICONSET" -o "$ICON_DIR/icon.icns"
    rm -rf "$ICONSET"
elif command -v png2icns &> /dev/null; then
    echo "Generating macOS .icns with png2icns..."
    png2icns "$ICON_DIR/icon.icns" "$ICON_DIR/128x128.png" "$ICON_DIR/128x128@2x.png"
else
    echo "Warning: Cannot generate .icns on Linux (install icnsutils for png2icns)"
fi

echo "Done! Icons generated in $ICON_DIR/"
ls -la "$ICON_DIR/"
