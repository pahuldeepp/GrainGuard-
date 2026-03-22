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

module "dynamodb" {
  source                      = "../../modules/dynamodb"
  project                     = var.project
  environment                 = "dev"
  create_terraform_lock_table = true
}

module "secrets_manager" {
  source      = "../../modules/secrets_manager"
  project     = var.project
  environment = "dev"
}

module "iam_irsa" {
  source                  = "../../modules/iam_irsa"
  project                 = var.project
  environment             = "dev"
  oidc_issuer_url         = module.eks.oidc_issuer_url
  oidc_provider_arn       = module.eks.oidc_provider_arn
  k8s_namespace           = "grainguard"
  secrets_read_policy_arn = module.secrets_manager.secrets_read_policy_arn
  dynamodb_table_arns     = module.dynamodb.all_table_arns
}

module "ecr" {
  source            = "../../modules/ecr"
  project           = var.project
  environment       = "dev"
  eks_node_role_arn = module.eks.node_role_arn
  ci_role_arn       = module.iam_irsa.ci_push_role_arn
}
