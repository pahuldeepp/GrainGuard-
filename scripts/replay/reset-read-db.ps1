Write-Host "Wiping read DB..."
docker exec -it grainguard-postgres-read psql -U postgres -d grainguard_read -c "TRUNCATE processed_events, device_telemetry_latest RESTART IDENTITY CASCADE;"
Write-Host "Read DB wiped."
