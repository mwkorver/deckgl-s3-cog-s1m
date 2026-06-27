# SAM custom build for the read-only zip Lambda (BuildMethod: makefile).
#
# SAM invokes `build-<LogicalId>` with ARTIFACTS_DIR set to the staging dir it
# will zip. We install ONLY the trimmed read deps (requirements-lambda.txt) so
# the package stays under Lambda's 250M unzipped limit alongside the DuckDB
# layer -- `sam build` against requirements.txt would pull pyarrow/pyproj/pillow
# and overflow. Source files are copied in; ingest modules are present but never
# imported (S3_COG_INGEST_MODE=disabled), so their pyarrow imports never run.
build-DeckglS3CogS1mReadFunction:
	python -m pip install -r requirements-lambda.txt -t "$(ARTIFACTS_DIR)"
	cp app.py "$(ARTIFACTS_DIR)/"
	cp aws_s3.py "$(ARTIFACTS_DIR)/"
	cp config.py "$(ARTIFACTS_DIR)/"
	# duckdb_s3.py is the read path's DuckDB-on-S3 connection helper (httpfs +
	# credential_chain); it imports only stdlib (duckdb comes from the layer).
	cp duckdb_s3.py "$(ARTIFACTS_DIR)/"
	# s1m.py serves /s1m/tiles (terrain coverage). app.py imports it at module
	# top level, so it must be present or cold start raises ModuleNotFoundError.
	# Its heavy deps (duckdb, pyproj, shapely) are lazy-imported inside the
	# request path: duckdb comes from the layer; pyproj + shapely must be in
	# requirements-lambda.txt for /s1m/tiles to serve (else 500 at call time).
	cp s1m.py "$(ARTIFACTS_DIR)/"
	# descriptors.py = collection registry + adapters. Module load is stdlib-only
	# (lazy boto3/ingest_manifest imports); the read path needs it for /collections
	# and /ingest/options (collection list + generic available_years). No pyarrow.
	cp descriptors.py "$(ARTIFACTS_DIR)/"
	cp ingest_jobs.py "$(ARTIFACTS_DIR)/"
	cp ingest_options.py "$(ARTIFACTS_DIR)/"
	cp lake.py "$(ARTIFACTS_DIR)/"
	cp probes.py "$(ARTIFACTS_DIR)/"
	cp -r ../viewer "$(ARTIFACTS_DIR)/viewer"
