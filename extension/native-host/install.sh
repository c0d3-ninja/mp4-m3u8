#!/bin/bash
# Registers the native-messaging host for every Chromium-based browser on this Mac,
# so the extension can read/write ~/Desktop/dramas-next.json. Re-run after moving the repo or changing Node.
set -euo pipefail

HOST_NAME="com.mp4m3u8.dramas_json"
EXTENSION_ID="mnbdkechdcbddnilcgdignpbkldljpjh" # fixed by the "key" in manifest.json
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi

# Browsers don't get your shell PATH (nvm etc.), so the launcher uses Node's absolute path.
LAUNCHER="$DIR/run-host.sh"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$DIR/host.js"
EOF
chmod +x "$LAUNCHER" "$DIR/host.js"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Writes TikTok dramas to ~/Desktop/dramas-next.json",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)

SUPPORT="$HOME/Library/Application Support"
TARGETS=(
  "Google/Chrome"
  "Google/Chrome Beta"
  "Google/Chrome Canary"
  "Chromium"
  "BraveSoftware/Brave-Browser"
  "Microsoft Edge"
  "Vivaldi"
  "Arc/User Data"
  "com.operasoftware.Opera"
)

for t in "${TARGETS[@]}"; do
  if [ -d "$SUPPORT/$t" ]; then
    mkdir -p "$SUPPORT/$t/NativeMessagingHosts"
    echo "$MANIFEST" > "$SUPPORT/$t/NativeMessagingHosts/$HOST_NAME.json"
    echo "Installed for: $t"
  fi
done

echo "Done. Extension ID: $EXTENSION_ID — restart the browser if it was open."
