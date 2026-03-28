# DR environment — us-west-2 secondary region
# Depends on prod environment — run prod/apply first, then pass outputs here.
# Failover procedure: see docs/runbooks/multi-region-failover.md

variable "aurora_global_cluster_id" { type = string }  # from prod output
variable "redis_global_datastore_id" { type = string } # from prod output
variable "db_password" {
  type      = string
  sensitive = true
}
variable "project" {
  type    = string
  default = "grainguard"
}
variable "aws_region" {
  type    = string
  default = "us-west-2"
}

module "vpc_dr" {
  source             = "../../modules/vpc"
  project            = var.project
  environment        = "dr"
  vpc_cidr           = "10.2.0.0/16"
  availability_zones = ["us-west-2a", "us-west-2b"]
}

module "eks_dr" {
  source             = "../../modules/eks"
  project            = var.project
  environment        = "dr"
  private_subnet_ids = module.vpc_dr.private_subnet_ids
  instance_type      = "m6i.large"
  desired_nodes      = 2 # scaled down in standby to save cost
}

# Aurora secondary — joins the global cluster, read-only until promotion
module "aurora_dr" {
  source             = "../../modules/aurora-global"
  project            = var.project
  environment        = "dr"
  vpc_id             = module.vpc_dr.vpc_id
  vpc_cidr           = "10.2.0.0/16"
  private_subnet_ids = module.vpc_dr.private_subnet_ids
  db_password        = var.db_password
  instance_class     = "db.r6g.large"
  is_secondary       = true
  global_cluster_id  = var.aurora_global_cluster_id
}

# Redis secondary — replicates from primary Global Datastore
module "redis_dr" {
  source              = "../../modules/elasticache-global"
  project             = var.project
  environment         = "dr"
  vpc_id              = module.vpc_dr.vpc_id
  vpc_cidr            = "10.2.0.0/16"
  private_subnet_ids  = module.vpc_dr.private_subnet_ids
  node_type           = "cache.r6g.large"
  is_secondary        = true
  global_datastore_id = var.redis_global_datastore_id
}

# DR Kafka cluster (standalone — MirrorMaker 2 replicates from primary)
# On failover: producers and consumers point here; MirrorMaker stops.
module "msk_dr" {
  source             = "../../modules/msk"
  project            = var.project
  environment        = "dr"
  vpc_id             = module.vpc_dr.vpc_id
  vpc_cidr           = "10.2.0.0/16"
  private_subnet_ids = module.vpc_dr.private_subnet_ids
  instance_type      = "kafka.m5.large"
}

output "dr_aurora_reader_endpoint" { value = module.aurora_dr.reader_endpoint }
output "dr_redis_primary_endpoint" { value = module.redis_dr.primary_endpoint }
output "dr_kafka_bootstrap_brokers" { value = module.msk_dr.bootstrap_brokers_tls }
