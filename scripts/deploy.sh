#!/usr/bin/env bash
set -euo pipefail

ENV=${1:-dev}   # usage: ./deploy.sh dev | ./deploy.sh prod
NAMESPACE="grainguard-${ENV}"
RELEASE="grainguard-${ENV}"

echo "▶ Deploying GrainGuard to environment: ${ENV}"

# 1. Ensure ArgoCD is installed
if ! kubectl get namespace argocd &>/dev/null; then
  echo "▶ Installing ArgoCD..."
  kubectl create namespace argocd
  kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
  echo "⏳ Waiting for ArgoCD to be ready..."
  kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=120s
fi

# 2. Apply AppProject
echo "▶ Applying ArgoCD AppProject..."
kubectl apply -f argocd/project.yaml

# 3. Apply App-of-Apps root
echo "▶ Applying App-of-Apps root..."
kubectl apply -f argocd/app-of-apps.yaml

# 4. Optionally do a direct Helm install for local dev (bypasses ArgoCD)
if [[ "${ENV}" == "dev" && "${LOCAL:-false}" == "true" ]]; then
  echo "▶ Local Helm install (dev only)..."
  helm upgrade --install "${RELEASE}" ./helm/grainguard \
    --namespace "${NAMESPACE}" \
    --create-namespace \
    -f helm/grainguard/values.yaml \
    -f helm/grainguard/values.dev.yaml \
    --set global.imageRegistry="" \
    --wait
fi

echo "✅ Done. ArgoCD will now sync grainguard-${ENV}."
echo "   Check status: kubectl get applications -n argocd"
echo "   Port-forward ArgoCD UI: kubectl port-forward svc/argocd-server -n argocd 8080:443"