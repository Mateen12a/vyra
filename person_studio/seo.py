"""Per-page titles, descriptions and share tags for the single-page app, filled in on the server.

Search engines and link previews (WhatsApp, X, LinkedIn, Slack) often read only the first HTML response, so the
page shell is rendered with the right fields for each public URL. Signed-in and one-time pages are kept out of search.
"""
import html
import json

DEFAULT_DESCRIPTION = ("Turn your webcam into anyone, live. Type a look or add a photo, press Go live, and Vyrani "
                       "changes your video in real time while you talk and move. Record, stream or use it in calls.")

PAGES = {
    "/": ("Vyrani: Turn your webcam into anyone, live", DEFAULT_DESCRIPTION),
    "/signup": ("Create your Vyrani account", "Make a free Vyrani account and try a live AI look on your own webcam."),
    "/signin": ("Sign in to Vyrani", "Sign in to the Vyrani studio and go live as anyone."),
}
PRIVATE_TITLE = "Vyrani"
# Paths listed in the sitemap, in order of importance.
SITEMAP = ("/", "/signup", "/signin")


def _jsonld(origin):
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "Vyrani",
        "url": origin + "/",
        "applicationCategory": "MultimediaApplication",
        "operatingSystem": "Web browser",
        "description": DEFAULT_DESCRIPTION,
        "image": origin + "/assets/brand/vyrani-og.jpg",
        "publisher": {"@type": "Organization", "name": "Vyrani", "logo": origin + "/assets/brand/vyrani-icon-512.png"},
    }, separators=(",", ":")).replace("<", "\\u003c")


def render(shell, path, origin):
    """Fill the __VY_…__ fields of the built index.html for `path`."""
    origin = origin.rstrip("/")
    public = path in PAGES
    title, description = PAGES.get(path, (PRIVATE_TITLE, DEFAULT_DESCRIPTION))
    fields = {
        "__VY_TITLE__": html.escape(title),
        "__VY_DESCRIPTION__": html.escape(description),
        "__VY_ROBOTS__": "index, follow, max-image-preview:large" if public else "noindex, nofollow",
        "__VY_URL__": html.escape(origin + (path if public else "/")),
        "__VY_ORIGIN__": html.escape(origin),
        "__VY_JSONLD__": _jsonld(origin),
    }
    for key, value in fields.items():
        shell = shell.replace(key, value)
    return shell


def robots(origin):
    return ("User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /api/\nDisallow: /studio\n"
            "Disallow: /verify\nDisallow: /reset\nDisallow: /forgot\n\n"
            f"Sitemap: {origin.rstrip('/')}/sitemap.xml\n")


def sitemap(origin):
    origin = origin.rstrip("/")
    urls = "".join(f"<url><loc>{html.escape(origin + p)}</loc><priority>{1.0 if p == '/' else 0.5}</priority></url>"
                   for p in SITEMAP)
    return f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>'
