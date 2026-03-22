variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "project" {
  description = "Project name"
  type        = string
  default     = "grainguard"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "eks_node_instance_type" {
  description = "EKS node instance type"
  type        = string
  default     = "t3.medium"
}

variable "eks_desired_nodes" {
  description = "EKS desired node count"
  type        = number
  default     = 2
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.medium"
}

variable "elasticache_node_type" {
  description = "Elasticache node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "msk_instance_type" {
  description = "MSK broker instance type"
  type        = string
  default     = "kafka.t3.small"
}
