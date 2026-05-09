FROM docker.elastic.co/elasticsearch/elasticsearch:9.4.0

# `analysis-kuromoji` is the standard Japanese analyzer plugin distributed by
# Elastic alongside the server. Installing it here means the container is
# usable with `analyzer: 'kuromoji'` out of the box for dev.
#
# `analysis-sudachi` (WorksApplications) is intentionally NOT installed:
# it's a third-party plugin that requires a version-matched binary + the
# sudachi dictionary file (~80MB) and is typically baked into a project's
# own production image. Operators picking `analyzer: 'sudachi'` in the
# admin UI on this dev image will see a rebuild error from ES — install
# the matching sudachi plugin in your own derived image first.
RUN bin/elasticsearch-plugin install --batch analysis-kuromoji
