#!/usr/bin/env bash
# Bootstrap ArgoCD + GrainGuard App of Apps
# Usage: ./k8s/argocd/install.sh
set -euo pipefail

ARGOCD_VERSION="v2.10.0"
ARGOCD_NAMESPACE="argocd"

echo "==> Installing ArgoCD ${ARGOCD_VERSION}..."
kubectl create namespace "${ARGOCD_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n "${ARGOCD_NAMESPACE}" \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"

echo "==> Waiting for ArgoCD to be ready..."
kubectl rollout status deployment/argocd-server -n "${ARGOCD_NAMESPACE}" --timeout=120s

echo "==> Applying App of Apps..."
kubectl apply -f k8s/argocd/app-of-apps.yaml

echo ""
echo "==> ArgoCD is ready."
echo "    Get admin password:"
echo "    kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
echo ""
echo "    Port-forward UI:"
echo "    kubectl port-forward svc/argocd-server -n argocd 8080:443"
echo ""
echo "    Login: https://localhost:8080  user: admin"
