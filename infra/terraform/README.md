# GrainGuard Terraform

Infrastructure as code for GrainGuard on AWS.

## Modules

| Module | Resource | Notes |
|--------|----------|-------|
| vpc | VPC, subnets, NAT gateway | Public + private subnets across 2 AZs |
| eks | EKS cluster + node group | K8s 1.29, t3.medium nodes |
| rds | RDS Postgres 16 | Multi-AZ in prod, single in dev |
| elasticache | Redis replication group | TLS enabled, 2 nodes in prod |
| msk | MSK Kafka 3.5.1 | 3 brokers in prod, 1 in dev |

## Usage
```bash
cd infra/terraform/environments/dev
terraform init
terraform plan -var="db_password=yourpassword"
terraform apply -var="db_password=yourpassword"
```

## State

Remote state via S3 + DynamoDB locking.
Uncomment the backend block in providers.tf before first apply.

## ADR

See ADR-001 through ADR-010 in /docs/adr for architecture decisions.
