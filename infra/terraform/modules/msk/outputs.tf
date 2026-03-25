output "bootstrap_brokers_tls"  { value = aws_msk_cluster.main.bootstrap_brokers_tls }
output "bootstrap_brokers_sasl" { value = aws_msk_cluster.main.bootstrap_brokers_sasl_scram }
output "cluster_arn"            { value = aws_msk_cluster.main.arn }
output "zookeeper_connect"      { value = aws_msk_cluster.main.zookeeper_connect_string }
