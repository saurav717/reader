#!/usr/bin/env bash
# Deploys Reader's LaTeX compiler to Google Cloud Run, from Cloud Shell
# (console.cloud.google.com → the >_ icon), signed in as the project's owner:
#
#   git clone https://github.com/saurav717/reader && cd reader
#   bash cloudrun/latex/deploy.sh
#
# It turns on the APIs it needs, builds the image with Cloud Build (all of
# TeX Live: too big for Cloud Shell's own disk), deploys it, and prints the
# two things the Worker needs: the service's address and its token. Run it
# again to deploy a newer server.py; the token is kept.
#
#   PROJECT  the project id, reader-509409 unless given as the first argument
#   REGION   us-central1 unless set
set -euo pipefail

PROJECT="${1:-${PROJECT:-reader-509409}}"
REGION="${REGION:-us-central1}"
SERVICE=reader-latex
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/reader/latex:$(date -u +%Y%m%d-%H%M%S)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Project $PROJECT, region $REGION"
gcloud config set project "$PROJECT" >/dev/null

# Google turns on none of the services below for a project without billing, free tier or not.
if [ "$(gcloud billing projects describe "$PROJECT" --format 'value(billingEnabled)' 2>/dev/null)" = "False" ]; then
  echo "This project has no billing account linked. Link one, then run this again:"
  echo "  https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT"
  exit 1
fi

say "Turning on Cloud Run, Artifact Registry and Cloud Build (a minute the first time)"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

say "A place for the image"
gcloud artifacts repositories describe reader --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create reader --location "$REGION" --repository-format docker --description "Reader's images"
# Only the newest two images are kept: each is ~2.5 GB, and storage past 0.5 GB is billed.
cat > /tmp/reader-cleanup.json <<'JSON'
[{"name": "keep-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
 {"name": "delete-rest", "action": {"type": "Delete"}, "condition": {"tagState": "any"}}]
JSON
gcloud artifacts repositories set-cleanup-policies reader --location "$REGION" --policy /tmp/reader-cleanup.json --no-dry-run >/dev/null || echo "(no cleanup policy: delete old images by hand now and then)"

say "Letting Cloud Build push the image and write its log"
NUMBER="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
for account in "$NUMBER-compute@developer.gserviceaccount.com" "$NUMBER@cloudbuild.gserviceaccount.com"; do
  for role in artifactregistry.writer logging.logWriter storage.objectViewer; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$account" --role "roles/$role" --condition None >/dev/null 2>&1 || true
  done
done

say "Building the image with Cloud Build (5–10 minutes: it fetches all of TeX Live)"
gcloud builds submit "$HERE" --tag "$IMAGE" --timeout 1800s

say "The token the Worker sends"
TOKEN="$(gcloud run services describe "$SERVICE" --region "$REGION" --format json 2>/dev/null \
  | python3 -c 'import json,sys
try:
    env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env", [])
    print(next((e["value"] for e in env if e["name"] == "LATEX_TOKEN"), ""))
except Exception:
    print("")' || true)"
if [ -z "$TOKEN" ]; then TOKEN="$(openssl rand -base64 32 | tr -d '\n')"; echo "a new one"; else echo "kept from the last deploy"; fi

say "Deploying to Cloud Run"
# Request-based billing, nothing running between compiles: within the free tier for a few hundred compiles a day.
gcloud run deploy "$SERVICE" --region "$REGION" --image "$IMAGE" \
  --allow-unauthenticated --port 8080 --execution-environment gen2 \
  --cpu 2 --memory 4Gi --cpu-boost --concurrency 2 --min-instances 0 --max-instances 4 --timeout 300 \
  --update-env-vars "LATEX_TOKEN=$TOKEN" --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
say "Checking it answers"
curl -fsS "$URL/" && echo

say "Done. For the Worker (docs/deploy.md):"
echo "  LATEX_CLOUD_RUN_URL   = $URL"
echo "  LATEX_CLOUD_RUN_TOKEN = $TOKEN"
