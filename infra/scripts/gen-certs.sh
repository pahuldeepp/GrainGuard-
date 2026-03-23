#!/usr/bin/env bash
# gen-certs.sh — Regenerate mTLS certificates for the GrainGuard telemetry pipeline.
#
# Generates:
#   ca.crt / ca.key                    — Self-signed CA (trust anchor)
#   telemetry-server.crt / .key        — Server cert for the telemetry-service gRPC endpoint
#   gateway-client.crt / .key          — Client cert used by the gateway to call telemetry-service
#
# Usage:
#   cd infra/scripts && bash gen-certs.sh
#   (or: from project root)  bash infra/scripts/gen-certs.sh
#
# Requirements: openssl ≥ 1.1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="${SCRIPT_DIR}/../certs"
mkdir -p "${CERTS_DIR}"
cd "${CERTS_DIR}"

DAYS=3650   # 10-year validity — rotate before production go-live

echo "[gen-certs] Generating CA key and certificate..."
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
openssl req -new -x509 -days ${DAYS} -key ca.key -out ca.crt \
  -subj "/O=GrainGuard/CN=GrainGuard Internal CA"

echo "[gen-certs] Generating telemetry-service server certificate..."
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out telemetry-server.key
openssl req -new -key telemetry-server.key -out telemetry-server.csr \
  -subj "/O=GrainGuard/CN=telemetry-service"
cat > telemetry-server.ext << 'EXT'
subjectAltName = DNS:telemetry-service, DNS:localhost
extendedKeyUsage = serverAuth
EXT
openssl x509 -req -days ${DAYS} \
  -in telemetry-server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -extfile telemetry-server.ext -out telemetry-server.crt
rm -f telemetry-server.csr telemetry-server.ext

echo "[gen-certs] Generating gateway client certificate..."
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out gateway-client.key
openssl req -new -key gateway-client.key -out gateway-client.csr \
  -subj "/O=GrainGuard/CN=gateway"
cat > gateway-client.ext << 'EXT'
subjectAltName = DNS:grainguard-gateway, DNS:gateway, DNS:localhost
extendedKeyUsage = clientAuth
EXT
openssl x509 -req -days ${DAYS} \
  -in gateway-client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -extfile gateway-client.ext -out gateway-client.crt
rm -f gateway-client.csr gateway-client.ext

echo ""
echo "[gen-certs] Done. Certificates written to: ${CERTS_DIR}"
echo "  CA:             ca.crt"
echo "  Server:         telemetry-server.crt / telemetry-server.key"
echo "  Gateway client: gateway-client.crt / gateway-client.key"
echo ""
echo "  Restart telemetry-service and gateway after regenerating:"
echo "  docker compose up -d --force-recreate telemetry-service gateway"
