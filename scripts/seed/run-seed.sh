#!/bin/bash
echo "Seeding read DB..."
docker exec -i grainguard-postgres-read psql -U postgres -d grainguard_read < scripts/seed/seed-dev.sql
echo "Seeding Elasticsearch..."
docker exec grainguard-postgres-read psql -U postgres -d grainguard_read -c \
  "COPY (SELECT d.device_id, d.tenant_id, d.serial_number, COALESCE(t.temperature::text,''), COALESCE(t.humidity::text,'') FROM device_projections d LEFT JOIN device_telemetry_latest t ON d.device_id = t.device_id) TO STDOUT WITH CSV" > /tmp/devices.csv
python3 scripts/seed/seed-elasticsearch.py
echo "All done."
