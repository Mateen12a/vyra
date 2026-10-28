"""Server-side admin tasks that need no admin account yet.

    python -m person_studio.admin_cli find <text>                 list accounts whose email contains <text>
    python -m person_studio.admin_cli make-admin <email>          give an account the admin role (opens /admin)
    python -m person_studio.admin_cli credits <email> <amount> <reason>   add (or, negative, remove) credits
"""
import secrets
import sys

from .config import Settings
from .credits import Ledger
from .store import Store


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    store = Store(Settings())
    command, target = argv[0], argv[1].strip()
    if command == "find":
        for user in store.users.find({"email": {"$regex": target, "$options": "i"}}).limit(50):
            print(user["email"], user.get("role", "user"), Ledger(store).balance(user["_id"]))
        return
    user = store.users.find_one({"email": target.lower()})
    if not user:
        sys.exit(f"No account with the email {target}. Try: find <part of the email>")
    if command == "make-admin":
        store.users.update_one({"_id": user["_id"]}, {"$set": {"role": "admin"}})
        store.audit(None, "set_role", user_id=user["_id"], role="admin", via="cli")
        print(f"{user['email']} is now an admin. Sign in and open /admin.")
    elif command == "credits" and len(argv) >= 4:
        amount, reason = int(argv[2]), " ".join(argv[3:])
        Ledger(store).apply(user["_id"], amount, "admin", f"admin:cli-{secrets.token_hex(8)}", reason=reason[:200])
        store.audit(None, "admin_credits", user_id=user["_id"], amount=amount, reason=reason, via="cli")
        print(f"{user['email']}: balance is now {Ledger(store).balance(user['_id'])} credits")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
