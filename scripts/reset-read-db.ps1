$ErrorActionPreference = "Stop"

Write-Host "Resetting read database..."

docker exec -i grainguard-postgres `
  psql -U postgres -d grainguard `
  -c "TRUNCATE TABLE device_telemetry_latest RESTART IDENTITY CASCADE;"

docker exec -i grainguard-postgres `
  psql -U postgres -d grainguard `
  -c "TRUNCATE TABLE processed_events;"

Write-Host "Read DB reset complete."