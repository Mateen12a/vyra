"""Credit prices. Users only ever see credits; this table is the one place money maps to credits.

1 credit = 1 second of live. Live sells at $6/min against an assumed fal cost of $0.04/s ($2.40/min).
Re-check the provider cost on the fal dashboard before changing anything here.
"""

CREDIT_USD = 0.10
LIVE_CREDITS_PER_SECOND = 1
# Live is billed in prepaid blocks: the browser must buy the next block before the current one ends.
LIVE_BLOCK_SECONDS = 30
# The free trial: long enough to see yourself transformed, short enough that farming accounts isn't worth it.
# Who gets it is decided in trial.py.
FREE_CREDITS_ON_VERIFY = 30

# Packs sold through Stripe Checkout. Amounts are in US cents; credits never expire. Credits are whole minutes
# (multiples of 60) and the bonus grows with every step, so a bigger pack is always better value.
# The deepest bonus (25%) still sells live at $4.80/min, twice the assumed provider cost.
PACKS = {
    "starter": {"name": "Starter", "credits": 240, "amount_cents": 2400},      # 4 min, list price
    "p50": {"name": "Short", "credits": 540, "amount_cents": 5000},            # 9 min, +8%
    "p70": {"name": "Session", "credits": 780, "amount_cents": 7000},          # 13 min, +11%
    "p90": {"name": "Plus", "credits": 1020, "amount_cents": 9000},            # 17 min, +13%
    "creator": {"name": "Creator", "credits": 1260, "amount_cents": 11000},    # 21 min, +15%
    "p240": {"name": "Regular", "credits": 2820, "amount_cents": 24000},       # 47 min, +17.5%
    "pro": {"name": "Pro", "credits": 6000, "amount_cents": 50000},            # 100 min, +20%
    "studio": {"name": "Studio", "credits": 12000, "amount_cents": 96000},     # 200 min, +25%
}

# Fixed credit cost per generation tool (provider cost x ~2.5, rounded up). Keep in step with the fal dashboard.
TOOLS = {
    "clip": 60,          # Wan 2.2 Animate Replace, ~$0.23 for a 3 s clip at 480p
    "voice_minute": 8,   # ElevenLabs voice changer, $0.30 per started minute
    "assist": 1,         # prompt assistant call
}


def public_catalogue():
    return {"credit_usd": CREDIT_USD, "live_credits_per_minute": LIVE_CREDITS_PER_SECOND * 60,
            "packs": [{"id": key, **pack} for key, pack in PACKS.items()], "tools": TOOLS}
