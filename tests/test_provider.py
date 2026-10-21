from types import SimpleNamespace

from person_studio.provider import ProviderGuard


def settings(**kw):
    return SimpleNamespace(fal_key="k", fal_min_balance_live=2.5, fal_min_balance_clip=1.5, fal_alert_balance=20, **kw)


def test_new_work_is_refused_only_below_the_floor():
    balance = {"v": 10.0}
    guard = ProviderGuard(settings(), fetch=lambda: balance["v"])
    assert guard.allows("live") and guard.allows("clip")
    guard.checked_at, balance["v"] = 0, 2.0
    assert not guard.allows("live") and guard.allows("clip")
    guard.checked_at, balance["v"] = 0, 1.0
    assert not guard.allows("clip")


def test_unknown_balance_never_blocks_users():
    assert ProviderGuard(settings(), fetch=lambda: None).allows("live")


def test_low_balance_alerts_the_operator_once():
    sent = []
    guard = ProviderGuard(settings(), notify=lambda subject, text: sent.append(subject), fetch=lambda: 12.0)
    guard.current(); guard.checked_at = 0; guard.current()
    assert len(sent) == 1 and "$12.00" in sent[0]
