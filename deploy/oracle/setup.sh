#!/usr/bin/env bash
# Vultron station — one-shot bootstrap for an Oracle Cloud Always Free instance (Ubuntu 24.04, arm64).
#
#   sudo deploy/oracle/setup.sh
#
# Installs Docker, opens 80/443 on the instance firewall, generates a station password, builds the image and
# starts the stack. Re-running it is safe: the password and the /data volume are kept.
#
# What it cannot do: open 80/443 in the VCN security list (that lives in the OCI console) or buy you a
# domain. Both are covered in deploy/oracle/README.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me with sudo: sudo deploy/oracle/setup.sh"
[ -f "$REPO_ROOT/Dockerfile" ] || die "run me from a checkout of the repo (Dockerfile not found)"
command -v curl >/dev/null || die "curl is missing"

# ---------------------------------------------------------------- 1. Docker
say "1/5  Docker"
if ! command -v docker >/dev/null; then
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 ca-certificates curl
fi
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing — apt-get install docker-compose-v2"
systemctl enable --now docker >/dev/null 2>&1 || true
note "docker $(docker --version | awk '{print $3}' | tr -d ,)"

# ---------------------------------------------------------------- 2. public address
say "2/5  public address"
PUBLIC_IP="${PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
	PUBLIC_IP="$(curl -fsS -H 'Authorization: Bearer Oracle' --max-time 3 \
		http://169.254.169.254/opc/v2/vnics/ 2>/dev/null \
		| tr ',' '\n' | grep '"publicIp"' | head -1 | sed 's/.*"publicIp":"\([^"]*\)".*/\1/' || true)"
fi
case "${PUBLIC_IP:-}" in
	'' | null) PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)" ;;
esac
[ -n "${PUBLIC_IP:-}" ] || die "could not read the public IP — re-run as PUBLIC_IP=1.2.3.4 sudo deploy/oracle/setup.sh"
note "instance: $PUBLIC_IP"

# sslip.io resolves <a-b-c-d>.sslip.io back to that address, so Let's Encrypt can issue a real certificate
# without owning a domain. Override with VULTRON_HOST=app.example.com if you have one pointed here.
HOST="${VULTRON_HOST:-$(printf '%s' "$PUBLIC_IP" | tr '.' '-').sslip.io}"
note "public URL: https://$HOST"

# ---------------------------------------------------------------- 3. password
say "3/5  station password"
ENV_FILE="$REPO_ROOT/deploy/oracle/.env"
PASSWORD=""
if [ -f "$ENV_FILE" ]; then
	PASSWORD="$(sed -n 's/^VULTRON_SITE_PASSWORD=//p' "$ENV_FILE" | head -1)"
	[ -n "$PASSWORD" ] && note "keeping the password already in deploy/oracle/.env"
fi
if [ -z "$PASSWORD" ]; then
	command -v openssl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssl
	PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-28)"
	note "generated a new 28-character password"
fi
[ ${#PASSWORD} -ge 12 ] || die "the stored password is under 12 characters — edit $ENV_FILE and re-run"
umask 077
printf 'VULTRON_HOST=%s\nVULTRON_SITE_PASSWORD=%s\n' "$HOST" "$PASSWORD" >"$ENV_FILE"
note "written to deploy/oracle/.env (mode 600) — that file is your only copy; back it up"

# ---------------------------------------------------------------- 4. instance firewall
say "4/5  instance firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	note "opened 80/443 with ufw"
else
	iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
	iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
	echo 'iptables-persistent iptables-persistent/autosave_v4 boolean true' | debconf-set-selections 2>/dev/null || true
	echo 'iptables-persistent iptables-persistent/autosave_v6 boolean true' | debconf-set-selections 2>/dev/null || true
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
	netfilter-persistent save >/dev/null 2>&1 || true
	note "opened 80/443 in iptables and saved the rules"
fi

# ---------------------------------------------------------------- 5. build + start
say "5/5  build and start (the first ARM build takes a few minutes)"
docker compose -f deploy/oracle/docker-compose.yml up -d --build

say "waiting for the station to pass its health check"
for _ in $(seq 1 60); do
	state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
		"$(docker compose -f deploy/oracle/docker-compose.yml ps -q station)" 2>/dev/null || echo none)"
	[ "$state" = healthy ] && break
	sleep 3
done
[ "${state:-}" = healthy ] || {
	docker compose -f deploy/oracle/docker-compose.yml logs --tail 40 station
	die "the station never became healthy — logs above"
}
note "station healthy"

say "waiting for Caddy to get a certificate for $HOST"
for _ in $(seq 1 30); do
	curl -fsS --max-time 5 "https://$HOST/api/health" >/dev/null 2>&1 && break
	sleep 4
done

if curl -fsS --max-time 5 "https://$HOST/api/health" >/dev/null 2>&1; then
	cat <<EOF

  ✔ your station is live

    URL       https://$HOST
    user      vultron
    password  cat $ENV_FILE

  Next: open it, log in, and add your model API keys in the app. Hosting is free; model calls are billed to
  whoever holds those keys, so keep the password to yourself and set a daily spend cap.
EOF
else
	cat <<EOF

  The stack is running but https://$HOST is not answering yet. Almost always this is the VCN security list:
  Oracle's console firewall is separate from the instance firewall this script just opened. In the console:

    Networking -> Virtual Cloud Networks -> your VCN -> Security Lists -> Default Security List
    Add Ingress Rules: 0.0.0.0/0, TCP, destination port 80   and   TCP, 443

  Caddy retries certificate issuance on its own, so nothing needs restarting once the ports are open.
  Logs:  docker compose -f deploy/oracle/docker-compose.yml logs -f caddy
EOF
fi
