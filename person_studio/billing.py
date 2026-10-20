"""Stripe Checkout for credit packs. Credits are granted only by the signed webhook, never by the browser."""
import stripe

from . import pricing
from .credits import Ledger
from .store import Store, utcnow


class BillingError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Billing:
    def __init__(self, settings, store: Store, ledger: Ledger):
        self.settings, self.store, self.ledger = settings, store, ledger
        self.client = stripe.StripeClient(settings.stripe_secret_key) if settings.stripe_secret_key else None

    def available(self):
        return bool(self.client and self.settings.stripe_webhook_secret)

    def checkout(self, user, pack_id, base_url):
        if not self.available():
            raise BillingError("Payments are not configured on this server yet.", 503)
        pack = pricing.PACKS.get(pack_id)
        if not pack:
            raise BillingError("Choose one of the listed credit packs.", 422)
        session = self.client.checkout.sessions.create(params={
            "mode": "payment",
            "customer_email": user["email"],
            "client_reference_id": str(user["_id"]),
            "line_items": [{"quantity": 1, "price_data": {
                "currency": "usd", "unit_amount": pack["amount_cents"],
                "product_data": {"name": f"VYRANI {pack['name']}: {pack['credits']:,} credits"}}}],
            "metadata": {"user_id": str(user["_id"]), "pack": pack_id, "credits": str(pack["credits"])},
            "success_url": f"{base_url}/app/credits?checkout=success",
            "cancel_url": f"{base_url}/app/credits?checkout=cancelled",
        })
        return {"url": session.url}

    def webhook(self, payload: bytes, signature: str):
        try:
            event = stripe.Webhook.construct_event(payload, signature, self.settings.stripe_webhook_secret)
        except (ValueError, stripe.SignatureVerificationError):
            raise BillingError("Invalid webhook signature.", 400)
        if event["type"] in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
            session = event["data"]["object"]
            if session.get("payment_status") == "paid":
                self._grant(session)
        return {"received": True}

    def _grant(self, session):
        from bson import ObjectId
        metadata = session.get("metadata") or {}
        pack = pricing.PACKS.get(metadata.get("pack"))
        # Trust our own pack table and the amount Stripe actually charged, not just metadata.
        if not pack or session.get("amount_total") != pack["amount_cents"] or session.get("currency") != "usd":
            self.store.audit("stripe", "checkout_mismatch", session_id=session.get("id"))
            return
        user_id = ObjectId(metadata["user_id"])
        # Keyed on the Checkout Session, so the two "completed" events Stripe may send grant once.
        self.ledger.apply(user_id, pack["credits"], "purchase", f"stripe:{session['id']}",
                          pack=metadata["pack"], amount_cents=pack["amount_cents"], stripe_session=session["id"])
        self.store.audit("stripe", "purchase", user_id=user_id, pack=metadata["pack"], at_ms=utcnow().timestamp())
