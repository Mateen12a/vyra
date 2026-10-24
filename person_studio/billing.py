"""Stripe Checkout for credit packs. Credits are granted only by the signed webhook, never by the browser."""
import stripe

from . import pricing
from .credits import InsufficientCredits, Ledger
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

    def checkout(self, user, pack_id, base_url, amount_usd=None):
        if not self.available():
            raise BillingError("Payments are not configured on this server yet.", 503)
        if pack_id == "custom":
            pack = pricing.custom_pack(amount_usd)
            if not pack:
                raise BillingError(f"Enter a whole amount from ${pricing.CUSTOM_MIN_USD} to ${pricing.CUSTOM_MAX_USD:,}.", 422)
        else:
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
        elif event["type"] == "charge.refunded":
            self._refund(event["data"]["object"])
        return {"received": True}

    def _refund(self, charge):
        """Take back the credits a refund pays for: all of them for a full refund, a share for a partial one."""
        intent = charge.get("payment_intent")
        purchase = self.store.ledger.find_one({"kind": "purchase", "payment_intent": intent}) if intent else None
        if not purchase:
            self.store.audit("stripe", "refund_unmatched", charge=charge.get("id"))
            return
        amount, refunded = purchase.get("amount_cents") or charge.get("amount") or 0, charge.get("amount_refunded") or 0
        if not amount or refunded <= 0:
            return
        owed = min(purchase["delta"], round(purchase["delta"] * refunded / amount))
        taken = -sum(row["delta"] for row in self.store.ledger.find({"kind": "refund", "payment_intent": intent}))
        due = owed - taken
        if due <= 0:
            return  # this refund total was already handled (Stripe can resend events)
        user_id = purchase["user_id"]
        # Credits already spent can't be taken back; remove what's there and record the rest.
        take = 0
        for _ in range(3):  # a live session may spend credits between reading the balance and taking them
            take = min(due, self.ledger.balance(user_id))
            if take <= 0:
                break
            try:
                self.ledger.apply(user_id, -take, "refund", f"refund:{intent}:{refunded}", payment_intent=intent,
                                  amount_refunded=refunded)
                break
            except InsufficientCredits:
                take = 0
        if take < due:
            self.store.audit("stripe", "refund_shortfall", user_id=user_id, payment_intent=intent, missing=due - take)

    def _grant(self, session):
        from bson import ObjectId
        metadata = session.get("metadata") or {}
        if metadata.get("pack") == "custom":  # trust what Stripe charged, and our own rate, not the metadata
            total = session.get("amount_total")
            pack = pricing.custom_pack(total // 100) if isinstance(total, int) and total % 100 == 0 else None
        else:
            pack = pricing.PACKS.get(metadata.get("pack"))
        # Trust our own pack table and the amount Stripe actually charged, not just metadata.
        if not pack or session.get("amount_total") != pack["amount_cents"] or session.get("currency") != "usd":
            self.store.audit("stripe", "checkout_mismatch", session_id=session.get("id"))
            return
        user_id = ObjectId(metadata["user_id"])
        # Keyed on the Checkout Session, so the two "completed" events Stripe may send grant once.
        self.ledger.apply(user_id, pack["credits"], "purchase", f"stripe:{session['id']}",
                          pack=metadata["pack"], amount_cents=pack["amount_cents"], stripe_session=session["id"],
                          payment_intent=session.get("payment_intent"))
        self.store.audit("stripe", "purchase", user_id=user_id, pack=metadata["pack"], at_ms=utcnow().timestamp())
