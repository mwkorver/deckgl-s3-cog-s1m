import os
import sys
import time
from unittest.mock import MagicMock


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aws_s3


def test_presign_client_uses_regional_virtual_hosted_endpoint(monkeypatch):
    calls = []
    fake_client = MagicMock()

    def fake_boto3_client(service_name, **kwargs):
        calls.append((service_name, kwargs))
        return fake_client

    monkeypatch.setenv("AWS_REGION", "us-west-2")
    monkeypatch.setattr(aws_s3, "_global_s3_client", None)
    monkeypatch.setattr(aws_s3, "_global_s3_client_creds_expiry", 0.0)
    monkeypatch.setattr(aws_s3, "_cached_creds", ("AKIA_TEST", "SECRET", "TOKEN", time.time() + 600))
    monkeypatch.setattr(aws_s3.boto3, "client", fake_boto3_client)

    assert aws_s3.get_s3_client() is fake_client
    assert calls
    service_name, kwargs = calls[0]
    assert service_name == "s3"
    assert kwargs["region_name"] == "us-west-2"
    assert "endpoint_url" not in kwargs
    assert kwargs["config"].s3["addressing_style"] == "virtual"


def test_signing_requester_pays_keeps_request_payer_param(monkeypatch):
    seen = {}

    class FakeClient:
        def generate_presigned_url(self, client_method, Params, ExpiresIn):
            seen["client_method"] = client_method
            seen["params"] = Params
            seen["expires_in"] = ExpiresIn
            return "https://s3.amazonaws.com/naip-analytic/ri/2021/60cm/rgbir_cog/41071/item.tif?signed=1"

    monkeypatch.setattr(aws_s3, "_cached_creds", ("AKIA_TEST", "SECRET", "TOKEN", time.time() + 600))
    monkeypatch.setattr(aws_s3, "get_s3_client", lambda: FakeClient())

    signed, headers = aws_s3._sign_s3_href_uncached(
        "s3://naip-analytic/ri/2021/60cm/rgbir_cog/41071/item.tif"
    )

    assert signed.startswith("https://s3.amazonaws.com/naip-analytic/")
    assert headers == {}
    assert seen["client_method"] == "get_object"
    assert seen["params"]["Bucket"] == "naip-analytic"
    assert seen["params"]["Key"] == "ri/2021/60cm/rgbir_cog/41071/item.tif"
    assert seen["params"]["RequestPayer"] == "requester"
