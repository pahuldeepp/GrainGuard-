Write-Host "=== GrainGuard Event Replay ==="

$before = (docker exec -it grainguard-postgres-read psql -U postgres -d grainguard_read -t -c "SELECT COUNT(*) FROM processed_events;").Trim()
Write-Host "Events before replay: $before"

Write-Host "`nStep 1: Wipe read DB..."
& ./scripts/replay/reset-read-db.ps1

Write-Host "`nStep 2: Reset Kafka offset..."
& ./scripts/replay/reset-offset.ps1

Write-Host "`nStep 3: Restart read-model-builder..."
Set-Location "infra/docker"
docker compose start read-model-builder
Set-Location "../.."

Write-Host "`nStep 4: Waiting 30s for pipeline to rebuild..."
Start-Sleep 30

$after = (docker exec -it grainguard-postgres-read psql -U postgres -d grainguard_read -t -c "SELECT COUNT(*) FROM processed_events;").Trim()
Write-Host "`nEvents after 30s of replay: $after"
Write-Host "=== Replay running — check Grafana for lag draining ==="
