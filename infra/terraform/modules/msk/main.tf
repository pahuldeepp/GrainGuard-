resource "aws_security_group" "msk" {
  name   = "${var.project}-${var.environment}-msk-sg"
  vpc_id = var.vpc_id

  ingress {
    description = "Kafka TLS"
    from_port   = 9094
    to_port     = 9094
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    description = "Kafka SASL/SCRAM over TLS"
    from_port   = 9096
    to_port     = 9096
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-${var.environment}-msk-sg" }
}

resource "aws_msk_configuration" "main" {
  name           = "${var.project}-${var.environment}-msk-config"
  kafka_versions = ["3.6.0"]

  server_properties = <<-EOT
    auto.create.topics.enable=false
    default.replication.factor=${var.environment == "prod" ? 3 : 1}
    min.insync.replicas=${var.environment == "prod" ? 2 : 1}
    num.partitions=6
    log.retention.hours=168
    log.segment.bytes=1073741824
    unclean.leader.election.enable=false
    delete.topic.enable=true
  EOT
}

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/aws/msk/${var.project}-${var.environment}"
  retention_in_days = 14
  tags              = { Name = "${var.project}-${var.environment}-msk-logs" }
}

resource "aws_msk_cluster" "main" {
  cluster_name           = "${var.project}-${var.environment}"
  kafka_version          = "3.6.0"
  number_of_broker_nodes = var.environment == "prod" ? 3 : 1

  broker_node_group_info {
    instance_type   = var.instance_type
    client_subnets  = slice(var.private_subnet_ids, 0, var.environment == "prod" ? 3 : 1)
    security_groups = [aws_security_group.msk.id]

    storage_info {
      ebs_storage_info {
        volume_size = var.environment == "prod" ? 500 : 100
      }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  client_authentication {
    sasl { scram = true }
    tls {}
  }

  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }

  open_monitoring {
    prometheus {
      jmx_exporter  { enabled_in_broker = true }
      node_exporter { enabled_in_broker = true }
    }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }

  tags = { Name = "${var.project}-${var.environment}-msk" }
}
