#!/usr/bin/env bash
# Hephaestus VPS bootstrap (Ubuntu/Debian). Run as root or with sudo.
# Installs Node 20, the GitHub CLI, and the Codex CLI, then clones Hephaestus.
# Interactive logins (codex login, gh auth login) must be done afterwards by hand.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/hephaestus}"
PROJECTS_DIR="${PROJECTS_DIR:-/srv/projects}"
REPO_URL="${REPO_URL:-https://github.com/OutisNanashi/Hephaestus.git}"

echo "==> Installing base packages"
apt-get update -y
apt-get install -y git curl ca-certificates

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v gh >/dev/null; then
  echo "==> Installing GitHub CLI"
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y
  apt-get install -y gh
fi

if ! command -v codex >/dev/null; then
  echo "==> Installing Codex CLI"
  npm install -g @openai/codex
fi

echo "==> Cloning Hephaestus into ${INSTALL_DIR}"
if [ ! -d "${INSTALL_DIR}/.git" ]; then
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi
mkdir -p "${PROJECTS_DIR}"

if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
  echo "==> Created ${INSTALL_DIR}/.env — fill in OPENAI_API_KEY (and Telegram values) now."
fi

echo ""
echo "Bootstrap done. Remaining manual steps (see deploy/DEPLOY.md):"
echo "  1. codex login        (interactive, once)"
echo "  2. gh auth login      (interactive, once)"
echo "  3. Edit ${INSTALL_DIR}/.env"
echo "  4. Create ${INSTALL_DIR}/hephaestus.vps.config.json and register projects"
echo "  5. Enable the systemd timer per project (deploy/systemd/)"
