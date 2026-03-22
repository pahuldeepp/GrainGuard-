# Aurora Global Database module
# Creates:
#   - An Aurora Global Cluster (the logical wrapper)
#   - A primary regional cluster (read+write) in the caller's region
#   - A DB subnet group and security group scoped to the VPC
#
# Usage: instantiate once for primary, then instantiate again with
#   is_secondary = true  +  global_cluster_id  for the DR region.

variable "project"          { type = string }
variable "environment"      { type = string }
variable "vpc_id"           { type = string }
variable "vpc_cidr"         { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "db_password"      { type = string; sensitive = true }
variable "instance_class"   { type = string; default = "db.r6g.large" }
variable "engine_version"   { type = string; default = "15.4" }
variable "is_secondary"     { type = bool; default = false }
variable "global_cluster_id"{ type = string; default = "" }  # required when is_secondary=true

locals {
  name = "${var.project}-${var.environment}"
}

# ── Security group ────────────────────────────────────────────────────────────
resource "aws_security_group" "aurora" {
  name   = "${local.name}-aurora"
  vpc_id = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]   # only allow traffic from within the VPC
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-aurora-sg" }
}

# ── Subnet group ──────────────────────────────────────────────────────────────
resource "aws_db_subnet_group" "aurora" {
  name       = "${local.name}-aurora"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${local.name}-aurora-subnet-group" }
}

# ── Global cluster (primary region creates it; secondary just references it) ──
resource "aws_rds_global_cluster" "this" {
  count = var.is_secondary ? 0 : 1   # only primary creates the global cluster

  global_cluster_identifier = "${local.name}-global"
  engine                    = "aurora-postgresql"
  engine_version            = var.engine_version
  database_name             = "grainguard"
  storage_encrypted         = true
}

# ── Regional cluster ──────────────────────────────────────────────────────────
resource "aws_rds_cluster" "this" {
  cluster_identifier = "${local.name}-aurora"

  # Link to the global cluster
  global_cluster_identifier = var.is_secondary ? var.global_cluster_id : aws_rds_global_cluster.this[0].id

  engine         = "aurora-postgresql"
  engine_version = var.engine_version
  engine_mode    = "provisioned"    # required for Global Database

  # Primary only — secondary inherits from global replication
  master_username = var.is_secondary ? null : "grainguard"
  master_password = var.is_secondary ? null : var.db_password

  db_subnet_group_name   = aws_db_subnet_group.aurora.name
  vpc_security_group_ids = [aws_security_group.aurora.id]

  skip_final_snapshot = var.environment != "prod"   # keep snapshot in prod
  deletion_protection = var.environment == "prod"

  # Performance Insights — helps diagnose slow queries
  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = { Name = "${local.name}-aurora" }

  lifecycle {
    # password is managed outside Terraform after initial creation
    ignore_changes = [master_password]
  }
}

# ── DB instances (one writer, one reader in primary; one reader in secondary) ─
resource "aws_rds_cluster_instance" "this" {
  count = var.is_secondary ? 1 : 2   # primary: 1 writer + 1 reader; DR: 1 reader

  identifier         = "${local.name}-aurora-${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = var.instance_class
  engine             = "aurora-postgresql"
  engine_version     = var.engine_version

  performance_insights_enabled = true
  monitoring_interval          = 60   # Enhanced Monitoring: 1-min granularity

  tags = { Name = "${local.name}-aurora-${count.index}" }
}

# ── Outputs ───────────────────────────────────────────────────────────────────
output "writer_endpoint"       { value = aws_rds_cluster.this.endpoint }
output "reader_endpoint"       { value = aws_rds_cluster.this.reader_endpoint }
output "global_cluster_id"     { value = var.is_secondary ? var.global_cluster_id : aws_rds_global_cluster.this[0].id }
output "cluster_identifier"    { value = aws_rds_cluster.this.cluster_identifier }
