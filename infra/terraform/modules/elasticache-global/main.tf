# ElastiCache Global Datastore module (Redis cross-region replication)
# Creates:
#   - A primary ElastiCache cluster (Multi-AZ) in the caller's region
#   - A Global Datastore that enables async replication to a secondary region
#
# The secondary region just calls this module with is_secondary=true
# and provides the global_datastore_id from the primary.

variable "project"             { type = string }
variable "environment"         { type = string }
variable "vpc_id"              { type = string }
variable "vpc_cidr"            { type = string }
variable "private_subnet_ids"  { type = list(string) }
variable "node_type"           { type = string; default = "cache.r6g.large" }
variable "is_secondary"        { type = bool; default = false }
variable "global_datastore_id" { type = string; default = "" }  # primary output

locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_security_group" "redis" {
  name   = "${local.name}-redis"
  vpc_id = var.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-redis-sg" }
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = var.private_subnet_ids
}

# Replication group (Multi-AZ, cluster mode disabled for simplicity)
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name}-redis"
  description          = "GrainGuard Redis ${var.environment}"

  node_type            = var.node_type
  num_cache_clusters   = 2           # 1 primary + 1 replica within region
  engine_version       = "7.1"
  port                 = 6379

  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]

  at_rest_encryption_enabled  = true
  transit_encryption_enabled  = true

  automatic_failover_enabled  = true    # promote replica if primary fails
  multi_az_enabled            = true

  # Global Datastore membership
  global_replication_group_id = var.is_secondary ? var.global_datastore_id : null

  lifecycle {
    ignore_changes = [num_cache_clusters]
  }

  tags = { Name = "${local.name}-redis" }
}

# Global Datastore — created only by the primary region
resource "aws_elasticache_global_replication_group" "this" {
  count = var.is_secondary ? 0 : 1

  global_replication_group_id_suffix = "${local.name}"
  primary_replication_group_id       = aws_elasticache_replication_group.redis.id

  # These are inherited by the primary cluster
  engine_version = "7.1"
}

output "primary_endpoint"     { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "reader_endpoint"      { value = aws_elasticache_replication_group.redis.reader_endpoint_address }
output "global_datastore_id"  { value = var.is_secondary ? var.global_datastore_id : (length(aws_elasticache_global_replication_group.this) > 0 ? aws_elasticache_global_replication_group.this[0].id : "") }
