#!/usr/bin/env python3
"""Gmail inbox messages over IMAP, as JSON, for the Herdr `gmail` mod.

  fetch.py list <email> [limit]      -> {"total": n, "unread": n, "messages": [{uid, thread, from, subject, date, seen}]}
  fetch.py show <email> <uid>          -> {from, to, subject, date, html|text}   (marks it read)
  fetch.py read <email> <uid> [...]     -> {"ok": true}   (marks those messages read)
  fetch.py archive <email> <uid> [...]  -> {"ok": true}   (removes the Inbox label; stays in All Mail)
  fetch.py delete <email> <uid> [...]   -> {"ok": true}   (moves to Trash)

The app password comes from macOS Keychain (service "herdr-gmail", account <email>), else from
$GOOGLE_APP_PASSWORD. Headers are read with BODY.PEEK, so listing never marks anything read.
Standard library only.
"""
import email.header
import email.policy
import email.utils
import imaplib
import json
import os
import re
import subprocess
import sys

HOST = "imap.gmail.com"
SERVICE = "herdr-gmail"


class Problem(Exception):
    pass


def password(account):
    try:
        r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    pw = os.environ.get("GOOGLE_APP_PASSWORD", "").strip()
    if pw:
        return pw
    raise Problem(f"No app password in Keychain (service '{SERVICE}', account {account})")


def decode(value):
    parts = []
    for text, charset in email.header.decode_header(value or ""):
        parts.append(text.decode(charset or "utf-8", "replace") if isinstance(text, bytes) else text)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def connect(account):
    imap = imaplib.IMAP4_SSL(HOST, timeout=20)
    imap.login(account, password(account).replace(" ", ""))
    return imap


def list_inbox(account, limit):
    imap = connect(account)
    try:
        imap.select("INBOX", readonly=True)
        _, data = imap.uid("SEARCH", None, "ALL")
        uids = data[0].split() if data and data[0] else []
        _, data = imap.uid("SEARCH", None, "UNSEEN")
        unread = len(data[0].split()) if data and data[0] else 0
        newest = list(reversed(uids))[:limit]
        messages = []
        if newest:
            _, rows = imap.uid("FETCH", b",".join(newest),
                               "(X-GM-THRID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            for row in rows:
                if not isinstance(row, tuple):
                    continue
                meta, raw = row[0].decode(), row[1]
                uid = re.search(r"UID (\d+)", meta)
                thread = re.search(r"X-GM-THRID (\d+)", meta)
                msg = email.message_from_bytes(raw)
                name, addr = email.utils.parseaddr(decode(msg.get("From")))
                when = email.utils.parsedate_to_datetime(msg.get("Date")) if msg.get("Date") else None
                messages.append({
                    "uid": uid.group(1) if uid else None,
                    "thread": format(int(thread.group(1)), "x") if thread else None,
                    "from": name or addr, "subject": decode(msg.get("Subject")) or "(no subject)",
                    "date": when.isoformat() if when else None,
                    "seen": "\\Seen" in meta,
                })
            messages.sort(key=lambda m: m["date"] or "", reverse=True)
        return {"total": len(uids), "unread": unread, "messages": messages}
    finally:
        imap.logout()


BODY_LIMIT = 400_000
DROP = re.compile(r"<(head|style|script)\b.*?</\1\s*>", re.I | re.S)


def show(account, uid):
    imap = connect(account)
    try:
        imap.select("INBOX")
        _, rows = imap.uid("FETCH", uid, "(BODY[])")
        raw = next((r[1] for r in rows or [] if isinstance(r, tuple)), None)
        if raw is None:
            raise Problem("Message not found (already archived or deleted?)")
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        when = email.utils.parsedate_to_datetime(msg["Date"]) if msg["Date"] else None
        out = {"from": decode(str(msg["From"] or "")), "to": decode(str(msg["To"] or "")),
               "subject": decode(str(msg["Subject"] or "")) or "(no subject)",
               "date": when.isoformat() if when else None}
        part = msg.get_body(preferencelist=("html", "plain"))
        content = part.get_content() if part else ""
        if part is not None and part.get_content_subtype() == "html":
            out["html"] = DROP.sub("", content)[:BODY_LIMIT]
        else:
            out["text"] = content[:BODY_LIMIT]
        return out
    finally:
        imap.logout()


def mark_read(account, uids):
    imap = connect(account)
    try:
        imap.select("INBOX")
        imap.uid("STORE", ",".join(uids), "+FLAGS", "(\\Seen)")
        return {"ok": True}
    finally:
        imap.logout()


def trash_mailbox(imap):
    _, rows = imap.list()
    for row in rows or []:
        line = row.decode(errors="replace") if isinstance(row, bytes) else str(row)
        if "\\Trash" in line:
            return line.rsplit(' "/" ', 1)[-1].strip()
    return '"[Gmail]/Trash"'


def change(account, uids, action):
    if not uids:
        return {"ok": True}
    imap = connect(account)
    try:
        imap.select("INBOX")
        ids = ",".join(uids)
        if action == "archive":
            typ, data = imap.uid("STORE", ids, "-X-GM-LABELS", "(\\Inbox)")
        else:
            typ, data = imap.uid("MOVE", ids, trash_mailbox(imap))
        if typ != "OK":
            raise Problem(f"{action} failed: {data}")
        return {"ok": True}
    finally:
        imap.logout()


def main():
    if len(sys.argv) < 3:
        raise SystemExit(json.dumps({"error": "usage: fetch.py list|read <email> ..."}))
    command, account = sys.argv[1], sys.argv[2]
    try:
        if command == "list":
            out = list_inbox(account, int(sys.argv[3]) if len(sys.argv) > 3 else 10)
        elif command == "show" and len(sys.argv) > 3 and sys.argv[3].isdigit():
            out = show(account, sys.argv[3])
        elif command == "read":
            out = mark_read(account, [u for u in sys.argv[3:] if u.isdigit()])
        elif command in ("archive", "delete"):
            out = change(account, [u for u in sys.argv[3:] if u.isdigit()], command)
        else:
            out = {"error": f"unknown command {command}"}
    except Problem as e:
        out = {"error": str(e)}
    except imaplib.IMAP4.error as e:
        out = {"error": f"IMAP: {e}"}
    except OSError as e:
        out = {"error": f"Network: {e}"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
