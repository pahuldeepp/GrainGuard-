# ADR-005: Postgres RLS for Standard-Tier Tenant Isolation

## Status
Accepted (planned for Phase 5 implementation)

## Date
2024-03-19

## Context
GrainGuard is a multi-tenant SaaS. Tenant data isolation is a security
requirement. Current isolation is implemented at the application layer
(WHERE tenant_id = $1 in every query). This relies on every developer
remembering to add the filter — a single omission exposes all tenant data.

## Decision
Add Postgres Row-Level Security (RLS) as a fourth isolation layer below
the application layer. RLS enforces tenant isolation at the database engine
level regardless of application query correctness.

## Implementation
```sql
ALTER TABLE device_projections ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON device_projections
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Application sets tenant context before queries:
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT * FROM device_projections; -- automatically filtered
```

## Isolation layers (defense in depth)
1. JWT claim extraction (BFF context)
2. Application-level WHERE tenant_id = $1
3. Redis cache keys scoped by tenant_id
4. Postgres RLS (this ADR) ← last line of defense

## Consequences
### Positive
- Tenant isolation enforced even if application has bugs
- Compliance evidence for SOC2 audit
- No performance overhead for well-indexed tenant_id columns

### Negative
- RLS policies must be maintained as schema evolves
- Superuser connections bypass RLS (migration user must be careful)
- Slight complexity in connection pool setup

## Alternatives Rejected
### Separate database per tenant
Rejected. Operational overhead scales with tenant count. Not viable at 1M+ tenants.

### Separate schema per tenant
Rejected. Schema migrations must run N times. Connection pooling complexity.
