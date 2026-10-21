import io
import json
import zipfile

from fastapi.testclient import TestClient

from person_studio.app import create_app
from person_studio.config import Settings


def test_public_url_supports_vyrani_and_preserves_existing_configuration(monkeypatch):
    monkeypatch.delenv("VYRANI_PUBLIC_URL", raising=False)
    monkeypatch.setenv("VYRA_PUBLIC_URL", "https://legacy.example")
    assert Settings().public_url == "https://legacy.example"
    monkeypatch.setenv("VYRANI_PUBLIC_URL", "https://vyrani.blackhevents.com")
    assert Settings().public_url == "https://vyrani.blackhevents.com"


def test_configured_public_host_is_accepted_and_unrelated_hosts_are_rejected(tmp_path):
    settings = Settings(data_dir=tmp_path, mongo_uri="", api_token="", fal_key="",
                        public_url="https://vyrani.blackhevents.com")
    with TestClient(create_app(settings), base_url=settings.public_url) as client:
        response = client.get("/manifest.webmanifest")
        assert response.status_code == 200
        assert response.json()["name"] == "Vyrani Studio"
        assert response.json()["short_name"] == "VYRANI"
        assert client.get("/manifest.webmanifest", headers={"Host": "vyrani.blackhevents.com.evil.example"}).status_code == 400
        assert client.get("/manifest.webmanifest", headers={"Host": "localhost"}).status_code == 200


def test_extension_bundle_uses_the_owned_testing_host_and_new_brand(tmp_path):
    settings = Settings(data_dir=tmp_path, mongo_uri="", api_token="", fal_key="")
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/virtual-cam/extension.zip")
    assert "vyrani-virtual-camera-extension.zip" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["name"] == "VYRANI AI Virtual Camera & Mic"
        assert manifest["version"] == "1.3.0"
        for matches in [manifest["host_permissions"], *[script["matches"] for script in manifest["content_scripts"]]]:
            assert "https://vyrani.com/*" in matches and "https://vyrani.blackhevents.com/*" in matches  # owned domains
            assert not any("vyra.ai" in match or "<all_urls>" in match for match in matches)
