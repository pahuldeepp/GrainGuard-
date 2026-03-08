Write-Host "Stopping read-model-builder..."
Set-Location "infra/docker"
docker compose stop read-model-builder
Start-Sleep 5

Write-Host "Resetting Kafka offset to beginning..."
docker exec -it grainguard-kafka kafka-consumer-groups --bootstrap-server localhost:9093 --group read-model-builder --topic telemetry.events --reset-offsets --to-earliest --execute

Write-Host "Offset reset done."
Set-Location "../.."
