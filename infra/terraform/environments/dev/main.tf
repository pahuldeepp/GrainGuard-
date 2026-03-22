module "vpc" {
  source             = "../../modules/vpc"
  project            = var.project
  environment        = "dev"
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b"]
}

module "eks" {
  source             = "../../modules/eks"
  project            = var.project
  environment        = "dev"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_type      = "t3.medium"
  desired_nodes      = 2
}

module "rds" {
  source             = "../../modules/rds"
  project            = var.project
  environment        = "dev"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.0.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_class     = "db.t3.medium"
  db_password        = var.db_password
}

module "elasticache" {
  source             = "../../modules/elasticache"
  project            = var.project
  environment        = "dev"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.0.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  node_type          = "cache.t3.micro"
}

module "msk" {
  source             = "../../modules/msk"
  project            = var.project
  environment        = "dev"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.0.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_type      = "kafka.t3.small"
}
