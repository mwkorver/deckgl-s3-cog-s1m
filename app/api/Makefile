# SAM custom build for the read-only zip Lambda (BuildMethod: makefile).
#
# SAM invokes `build-<LogicalId>` with ARTIFACTS_DIR set to the staging dir it
# will zip. We install ONLY the trimmed read deps (requirements-lambda.txt) so
# the package stays under Lambda's 250M unzipped limit alongside the DuckDB
# layer -- `sam build` against requirements.txt would pull pyarrow/pyproj/pillow
# and overflow. Source files are copied in; ingest modules are present but never
# imported (S3_COG_INGEST_MODE=disabled), so their pyarrow imports never run.
build-CogStacReadFunction:
	python -m pip install -r requirements-lambda.txt -t "$(ARTIFACTS_DIR)"
	cp app.py "$(ARTIFACTS_DIR)/"
	# duckdb_s3.py is the read path's DuckDB-on-S3 connection helper (httpfs +
	# credential_chain); it imports only stdlib (duckdb comes from the layer).
	cp duckdb_s3.py "$(ARTIFACTS_DIR)/"
	# descriptors.py = collection registry + adapters. Module load is stdlib-only
	# (lazy boto3/ingest_manifest imports); the read path needs it for /collections
	# and /ingest/options (collection list + generic available_years). No pyarrow.
	cp descriptors.py "$(ARTIFACTS_DIR)/"
	cp -r ../viewer "$(ARTIFACTS_DIR)/viewer"
