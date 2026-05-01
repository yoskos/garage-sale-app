#!/usr/bin/env bash
# Bootstrap the garage-sale-app dev environment in WSL Ubuntu.
# Run from the project root: bash bootstrap.sh

set -euo pipefail

echo "==> Checking prerequisites..."

command -v python3.12 >/dev/null 2>&1 || {
  echo "Installing python3.12..."
  sudo apt update
  sudo apt install -y python3.12 python3.12-venv python3-pip
}

command -v node >/dev/null 2>&1 || {
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
}

command -v claude >/dev/null 2>&1 || {
  echo "Installing Claude Code..."
#  npm install -g @anthropic-ai/claude-code
}

command -v git >/dev/null 2>&1 || sudo apt install -y git

echo "==> Setting up backend Python venv..."
cd backend
if [ ! -d .venv ]; then
  python3.12 -m venv .venv
fi
source .venv/bin/activate
pip install -U pip
# pip install -r requirements.txt  # uncomment after Claude Code generates this
deactivate
cd ..

echo "==> Initializing git repo..."
if [ ! -d .git ]; then
  git init -b main
  git add .
  git commit -m "Initial spec scaffold" >/dev/null
fi

echo ""
echo "Done. Next steps:"
echo "  1. cd $(pwd)"
echo "  2. claude          # launch Claude Code"
echo "  3. Tell it: 'read docs/backend-spec.md and implement the backend'"
echo "  4. Then:    'read docs/android-spec.md and implement the Android app'"
