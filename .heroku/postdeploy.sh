#!/bin/bash
set -e

ROOTDIR=$(cd `dirname $0`/.. && pwd)
ENVFILE="${ROOTDIR}/.env"

if [ -f "$ENVFILE" ]; then
    echo "Exit deploy script because .env exists and won't re-create."
    exit 0
fi

if [ -z "$HEROKU_APP_NAME" ]; then
  echo "Exit postdeploy script with errors."
  echo ""
  echo "To deploy heroku, BASE_URL is built by HEROKU_APP_NAME required."
  echo ""
  exit 1
fi

BASE_URL="https://${HEROKU_APP_NAME}.herokuapp.com"

echo "BASE_URL=$BASE_URL" > "$ENVFILE"

echo "BASE_URL is set:"
echo "$BASE_URL"
echo ""
