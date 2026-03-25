# Runbook: gRPC Inter-Service Outage

**Alert:** `GrpcErrorRateHigh` / circuit breaker open in service logs
**Severity:** Critical
**Service affected:** Any service using gRPC (telemetry-service, asset-registry, saga-orchestrator)

---

## Symptoms
- HTTP 503 from gateway with `upstream connect error`
- Service logs: `rpc error: code = Unavailable`
- Circuit breaker logs: `circuit breaker open for <service>`
- mTLS certificate errors in logs

---

## Diagnosis

```bash
# 1. Which gRPC service is failing?
kubectl logs -n grainguard-dev deploy/gateway --since=10m \
  | grep -i "grpc\|rpc error\|unavailable"

# 2. Check the target service pod is running
kubectl get pods -n grainguard-dev -l app=telemetry-service
kubectl get pods -n grainguard-dev -l app=asset-registry

# 3. Test gRPC connectivity directly (requires grpcurl)
kubectl run grpc-test --rm -it --image=fullstorydev/grpcurl \
  --restart=Never -n grainguard-dev -- \
  -plaintext telemetry-service:50051 list

# 4. Check mTLS certificate expiry
kubectl get secret grainguard-tls -n grainguard-dev -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -dates

# 5. Check service endpoints are registered
kubectl get endpoints -n grainguard-dev telemetry-service
kubectl get endpoints -n grainguard-dev asset-registry
```

---

## Fix — Target service pod is down

```bash
kubectl rollout restart deployment/telemetry-service -n grainguard-dev
kubectl rollout status deployment/telemetry-service -n grainguard-dev --timeout=60s

# Circuit breaker will close automatically once service is healthy
# Watch for: "circuit breaker closed" in caller logs
kubectl logs -n grainguard-dev deploy/gateway --since=2m | grep "circuit"
```

---

## Fix — mTLS certificate expired

```bash
# Renew the TLS secret (cert-manager will auto-renew if configured)
kubectl annotate certificate grainguard-tls -n grainguard-dev \
  cert-manager.io/issue-temporary-certificate="true"

# Or manually rotate:
kubectl delete secret grainguard-tls -n grainguard-dev
# cert-manager will recreate it automatically

# Restart services to pick up new certs
kubectl rollout restart deployment/telemetry-service \
  deployment/saga-orchestrator deployment/asset-registry \
  -n grainguard-dev
```

---

## Fix — Service endpoint not registered (pod not ready)

```bash
# Check why pod is not passing readiness probe
kubectl describe pod -n grainguard-dev -l app=telemetry-service \
  | grep -A10 "Readiness"

# Check liveness probe failures
kubectl describe pod -n grainguard-dev -l app=telemetry-service \
  | grep -A5 "Liveness"

# Common fix: service needs env var / secret that's missing
kubectl get pod -n grainguard-dev -l app=telemetry-service \
  -o jsonpath='{.items[0].spec.containers[0].env}' | jq .
```

---

## Verify recovery

```bash
# No gRPC errors in gateway
kubectl logs -n grainguard-dev deploy/gateway --since=2m \
  | grep -c "rpc error"
# Expected: 0

# Circuit breaker closed
kubectl logs -n grainguard-dev deploy/gateway --since=2m \
  | grep "circuit breaker"

# End-to-end test
curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_JWT" \
  -d '{"query":"{ devices(limit:1) { deviceId } }"}' | jq .
```

---

## Escalate if
- All replicas of a service failing readiness simultaneously
- Certificate renewal failing (cert-manager issue)
- Network policy blocking inter-service traffic
