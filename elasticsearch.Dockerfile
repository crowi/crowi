# crowi/docker-elasticsearch:<es>   (kuromoji variant — the default)
#
# This is ALSO the dev ES image (docker-compose.yml builds it with the default
# ES_VERSION, so dev stays on 9.4.0 unchanged). The docker-elasticsearch.yml
# workflow overrides ES_VERSION via --build-arg to publish multi-arch images.

ARG ES_VERSION=9.4.0
FROM docker.elastic.co/elasticsearch/elasticsearch:${ES_VERSION}

# `analysis-kuromoji` is the standard Japanese analyzer plugin distributed by
# Elastic alongside the server. Installing it here means the container is
# usable with `analyzer: 'kuromoji'` out of the box for dev.
#
# `analysis-sudachi` (WorksApplications) is intentionally NOT installed:
# it's a third-party plugin that requires a version-matched binary + the
# sudachi dictionary file (~80MB) and is shipped in the separate `-sudachi`
# variant (elasticsearch/Dockerfile.sudachi). Operators picking `analyzer:
# 'sudachi'` in the admin UI on this kuromoji image will see a rebuild error
# from ES — use the `-sudachi` tag instead.
RUN bin/elasticsearch-plugin install --batch analysis-kuromoji

# Aggregated attribution / license notices for the bundled components. The
# upstream Elasticsearch LICENSE.txt / NOTICE.txt under
# /usr/share/elasticsearch/ are retained (NOT removed). The COPY is relative to
# the build context root (the repo root in both dev compose and the workflow).
COPY elasticsearch/NOTICE /usr/share/elasticsearch/CROWI-NOTICE.txt
