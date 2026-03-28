-- ── Performance indexes ────────────────────────────────────────────────────
-- Added to eliminate sequential scans on the most common query patterns:
--   • tenant-scoped telemetry join  (getAllTelemetry, manyDeviceTelemetry)
--   • tenant-scoped device list     (getAllDevicesWithTelemetry, devicesConnection)
--   • single-device tenant check    (getDeviceWithTelemetry)

-- Composite index: tenant-scoped telemetry queries
-- Covers WHERE tenant_id = $1 and the JOIN ON device_id used by resolvers.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_telemetry_tenant_device
    ON device_telemetry_latest (tenant_id, device_id);

-- Composite index: tenant-scoped device list ordered by creation time.
-- Covers WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT n.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_projections_tenant_created
    ON device_projections (tenant_id, created_at DESC);

-- Covering index: device lookup including tenant_id.
-- Avoids a heap fetch when checking tenant ownership after a device_id seek.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_projections_device_tenant
    ON device_projections (device_id, tenant_id);
