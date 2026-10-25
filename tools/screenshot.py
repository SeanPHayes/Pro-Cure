"""Dev helper: screenshot pages of the running web app as a given demo user.

usage: python3 tools/screenshot.py <email|-> <out_dir> <path> [<path> ...]
   e.g. python3 tools/screenshot.py marcus@jmhs-demo.com /tmp/shots /app /app/orders
Use '-' as the email to stay signed out. Set WIDTH/HEIGHT env to change the viewport.
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:5173")
email, out, paths = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(out, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(
        viewport={"width": int(os.environ.get("WIDTH", 1440)), "height": int(os.environ.get("HEIGHT", 900))},
        device_scale_factor=1,
    )
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE + "/login")
    if email != "-":
        req = urllib.request.Request(
            BASE + "/api/identity/auth/dev/login",
            data=json.dumps({"email": email}).encode(),
            headers={"content-type": "application/json"},
        )
        r = json.load(urllib.request.urlopen(req))
        session = {
            "accessToken": r["accessToken"],
            "refreshToken": r["refreshToken"],
            "expiresAt": 9999999999999,
            "user": r["user"],
            "context": r["context"],
            "contexts": r["contexts"],
        }
        page.evaluate("s => localStorage.setItem('procure.session', JSON.stringify(s))", session)
    for path in paths:
        page.goto(BASE + path)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(int(os.environ.get("WAIT", 600)))
        name = path.strip("/").replace("/", "_") or "root"
        f = os.path.join(out, f"{name}.png")
        page.screenshot(path=f, full_page=os.environ.get("FULL") == "1")
        print(f)
    if errors:
        print("console errors:", *errors[:10], sep="\n  ")
    browser.close()
