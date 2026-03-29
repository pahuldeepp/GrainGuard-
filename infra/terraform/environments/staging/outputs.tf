output "eks_cluster_name" { value = module.eks.cluster_name }
output "eks_cluster_endpoint" { value = module.eks.cluster_endpoint }
output "rds_endpoint" { value = module.rds.endpoint }
output "redis_endpoint" { value = module.elasticache.primary_endpoint }
output "kafka_brokers_tls" { value = module.msk.bootstrap_brokers_tls }
output "kafka_brokers_sasl" { value = module.msk.bootstrap_brokers_sasl }
output "ecr_repository_urls" { value = module.ecr.repository_urls }
output "service_role_arns" { value = module.iam_irsa.service_role_arns }
output "secret_names" { value = module.secrets_manager.secret_names }
output "dynamodb_tables" {
  value = {
    feature_flags       = module.dynamodb.feature_flags_table_name
    idempotency_keys    = module.dynamodb.idempotency_keys_table_name
    rate_counters       = module.dynamodb.rate_counters_table_name
    webhook_retry_state = module.dynamodb.webhook_retry_state_table_name
  }
}
