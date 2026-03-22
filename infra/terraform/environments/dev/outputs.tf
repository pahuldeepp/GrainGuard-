output "eks_cluster_name"      { value = module.eks.cluster_name }
output "eks_cluster_endpoint"  { value = module.eks.cluster_endpoint }
output "rds_endpoint"          { value = module.rds.endpoint }
output "redis_endpoint"        { value = module.elasticache.primary_endpoint }
output "kafka_brokers"         { value = module.msk.bootstrap_brokers }
