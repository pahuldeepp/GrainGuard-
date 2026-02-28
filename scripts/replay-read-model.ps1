docker exec -i grainguard-postgres-read `
  psql -U postgres -d grainguard_read `
  -c "TRUNCATE TABLE device_telemetry_latest RESTART IDENTITY CASCADE;"

docker exec -i grainguard-postgres-read `
  psql -U postgres -d grainguard_read `
  -c "TRUNCATE TABLE processed_events;"

Write-Host "Read DB reset complete."