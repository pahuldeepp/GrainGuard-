#!/usr/bin/env bash
# Usage: ./bump-image-tag.sh gateway 1.2.3 prod
set -euo pipefail

SERVICE=$1
TAG=$2
ENV=${3:-dev}

FILE="argocd/environments/${ENV}.yaml"

echo "▶ Bumping ${SERVICE}.image.tag → ${TAG} in ${FILE}"

# Uses yq — install with: brew install yq
yq e "
  .spec.source.helm.parameters[] |=
  select(.name == \"${SERVICE}.image.tag\") .value = \"${TAG}\"
" -i "${FILE}"

git add "${FILE}"
git commit -m "chore(deploy): bump ${SERVICE} image tag to ${TAG} in ${ENV}"
git push

echo "✅ ArgoCD will auto-sync within 3 minutes (or trigger manually in UI)"
