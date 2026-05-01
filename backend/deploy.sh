#!/usr/bin/env bash
# Idempotent deploy script for Ubuntu 24.04 droplet.
# Run as root: bash deploy.sh [your-domain.example.com]
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/garage-sale-app"
SERVICE="garage-sale"
REPO="https://github.com/yoskos/garage-sale-app.git"

echo "=== 1. System packages ==="
apt-get update -qq
apt-get install -y -qq python3.12 python3.12-venv python3-pip git curl ufw

# Install Caddy
if ! command -v caddy &>/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] \
https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
        > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
fi

echo "=== 2. Clone / update repo ==="
if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
else
    git clone "$REPO" "$APP_DIR"
fi

echo "=== 3. Python venv ==="
python3.12 -m venv "$APP_DIR/backend/.venv"
"$APP_DIR/backend/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/backend/.venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

echo "=== 4. Environment file ==="
ENV_FILE="$APP_DIR/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    read -rsp "ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY; echo
    SHARED_SECRET=$(openssl rand -hex 32)
    cat > "$ENV_FILE" <<EOF
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
SHARED_SECRET=$SHARED_SECRET
DATABASE_PATH=$APP_DIR/backend/garage_sale.db
CACHE_DIR=$APP_DIR/backend/image_cache
PORT=8000
EOF
    chmod 600 "$ENV_FILE"
    echo "Generated SHARED_SECRET=$SHARED_SECRET  <-- copy to phones"
else
    echo "  .env already exists, skipping"
fi

echo "=== 5. systemd service ==="
cp "$APP_DIR/backend/garage-sale.service" /etc/systemd/system/${SERVICE}.service
systemctl daemon-reload
systemctl enable --now ${SERVICE}
systemctl restart ${SERVICE}

echo "=== 6. Caddy config ==="
if [ -n "$DOMAIN" ]; then
    cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8000
}
EOF
else
    cat > /etc/caddy/Caddyfile <<EOF
:443 {
    tls internal
    reverse_proxy 127.0.0.1:8000
}
EOF
fi
systemctl reload caddy

echo "=== 7. Firewall ==="
ufw allow 443/tcp
ufw allow 22/tcp
ufw --force enable

echo ""
echo "=== Done ==="
SHARED_SECRET=$(grep SHARED_SECRET "$ENV_FILE" | cut -d= -f2)
if [ -n "$DOMAIN" ]; then
    URL="https://$DOMAIN"
else
    URL="https://$(curl -s ifconfig.me)"
fi
echo "Server: $URL"
echo "Shared secret for phones: $SHARED_SECRET"
echo ""
echo "QR code (scan on each phone):"
echo "$SHARED_SECRET" | qrencode -t UTF8 2>/dev/null || echo "  (install qrencode for QR: apt-get install qrencode)"
