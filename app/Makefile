# SAM custom build for the read-only zip Lambda (BuildMethod: makefile).
# Runs in the context of the CodeUri directory (app/).
build-CogStacReadFunction:
	python3 -m pip install -r api/requirements-lambda.txt -t "$(ARTIFACTS_DIR)"
	cp api/app.py "$(ARTIFACTS_DIR)/"
	# duckdb_s3.py is the read path's DuckDB-on-S3 connection helper (httpfs +
	# credential_chain); it imports only stdlib (duckdb comes from the layer).
	cp api/duckdb_s3.py "$(ARTIFACTS_DIR)/"
	# descriptors.py = collection registry + adapters. Module load is stdlib-only
	# (lazy boto3/ingest_manifest imports); the read path needs it for /collections
	# and /ingest/options (collection list + generic available_years). No pyarrow.
	cp api/descriptors.py "$(ARTIFACTS_DIR)/"
	# Copy the viewer folder directly from the build context
	cp -r viewer "$(ARTIFACTS_DIR)/viewer"
