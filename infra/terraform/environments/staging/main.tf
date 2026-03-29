module "vpc" {
  source             = "../../modules/vpc"
  project            = var.project
  environment        = "staging"
  vpc_cidr           = "10.10.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b"]
}

module "eks" {
  source             = "../../modules/eks"
  project            = var.project
  environment        = "staging"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_type      = "t3.large"
  desired_nodes      = 2
}

module "rds" {
  source             = "../../modules/rds"
  project            = var.project
  environment        = "staging"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.10.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_class     = "db.t3.medium"
  db_password        = var.db_password
}

module "elasticache" {
  source             = "../../modules/elasticache"
  project            = var.project
  environment        = "staging"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.10.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  node_type          = "cache.t3.small"
}

module "msk" {
  source             = "../../modules/msk"
  project            = var.project
  environment        = "staging"
  vpc_id             = module.vpc.vpc_id
  vpc_cidr           = "10.10.0.0/16"
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_type      = "kafka.t3.small"
}

module "dynamodb" {
  source                      = "../../modules/dynamodb"
  project                     = var.project
  environment                 = "staging"
  create_terraform_lock_table = false
}

module "secrets_manager" {
  source      = "../../modules/secrets_manager"
  project     = var.project
  environment = "staging"
}

module "iam_irsa" {
  source                  = "../../modules/iam_irsa"
  project                 = var.project
  environment             = "staging"
  oidc_issuer_url         = module.eks.oidc_issuer_url
  oidc_provider_arn       = module.eks.oidc_provider_arn
  k8s_namespace           = "grainguard-staging"
  secrets_read_policy_arn = module.secrets_manager.secrets_read_policy_arn
  dynamodb_table_arns     = module.dynamodb.all_table_arns
}

module "ecr" {
  source            = "../../modules/ecr"
  project           = var.project
  environment       = "staging"
  eks_node_role_arn = module.eks.node_role_arn
  ci_role_arn       = module.iam_irsa.ci_push_role_arn
}
