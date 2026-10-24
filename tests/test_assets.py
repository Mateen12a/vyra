from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "person_studio" / "web"


def test_live_engine_files_ship_with_the_app():
    # Go live loads these before contacting the server; a missing one silently breaks live mode.
    for name in ("vendor/msgpack.js", "fal-live.js"):
        assert (WEB / name).is_file() and (WEB / name).stat().st_size > 1000, name
