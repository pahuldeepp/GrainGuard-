# Production environment — us-east-1 primary region
# Paired with environments/dr/ which deploys the DR secondary in us-west-2.

module "vpc" {
  source             = "../../modules/vpc"
  project            = var.project
  environment        = "prod"
  vpc_cidr           = "10.1.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

module "eks" {
  source             = "../../modules/eks"
  project            = var.project
  environment        = "prod"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_type      = "m6i.xlarge"
  desired_nodes      = 6
}

# Aurora Global Database — primary cluster created here
# DR region references the global_cluster_id output
module "aurora" {
  source             = "../../modules/aurora-global"
  project            = var.project
  environment        = "prod"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.1.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  db_password        = var.db_password
  instance_class     = "db.r6g.large"
  is_secondary       = false
}

# ElastiCache Global Datastore — primary cluster created here
module "redis" {
  source             = "../../modules/elasticache-global"
  project            = var.project
  environment        = "prod"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.1.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  node_type          = "cache.r6g.large"
  is_secondary       = false
}

module "msk" {
  source             = "../../modules/msk"
  project            = var.project
  environment        = "prod"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.1.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_type      = "kafka.m5.large"
}

# ── Outputs consumed by the DR region ────────────────────────────────────────
output "aurora_global_cluster_id" { value = module.aurora.global_cluster_id }
output "redis_global_datastore_id" { value = module.redis.global_datastore_id }
output "msk_bootstrap_brokers" { value = module.msk.bootstrap_brokers_tls }
