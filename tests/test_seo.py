from person_studio import seo

SHELL = ('<title>__VY_TITLE__</title><meta name="robots" content="__VY_ROBOTS__"><link rel="canonical" href="__VY_URL__">'
         '<meta property="og:image" content="__VY_ORIGIN__/x.jpg"><script>__VY_JSONLD__</script>')


def test_public_page_gets_its_own_tags():
    out = seo.render(SHELL, "/signup", "https://vyrani.example/")
    assert "<title>Create your Vyrani account</title>" in out
    assert 'content="index, follow' in out and 'href="https://vyrani.example/signup"' in out
    assert "https://vyrani.example/x.jpg" in out and "__VY_" not in out


def test_private_pages_are_kept_out_of_search():
    out = seo.render(SHELL, "/app/credits", "https://vyrani.example")
    assert 'content="noindex, nofollow"' in out and 'href="https://vyrani.example/"' in out


def test_robots_and_sitemap():
    assert "Disallow: /app" in seo.robots("https://v.example") and "Sitemap: https://v.example/sitemap.xml" in seo.robots("https://v.example")
    xml = seo.sitemap("https://v.example/")
    assert "<loc>https://v.example/</loc>" in xml and "<loc>https://v.example/signup</loc>" in xml and "/app" not in xml
