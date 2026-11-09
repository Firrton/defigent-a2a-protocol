#!/usr/bin/env python3
"""Multi-chain scan 07-nov: Taifoon hooks/work + readiness, Base identity/balances
+ Registered events scan, Monad mint frontier. Run with Hermes python.
"""
import json, time, socket, urllib.request, urllib.parse, sqlite3
from eth_utils import keccak

sel = lambda sig: "0x" + keccak(text=sig).hex()[:8]
UA = {"Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
WALLET = "0x940ecB27d8f4F7009c8BC12969496E9639717638"
IDENT = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
AGENT_BASE = 114426
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
SPAM = ("centralcity", "termix-platform", "amazonaws.com/platform", "sample/", "ap-southeast-1", "litprotocol.com/api/flows")
KNOWN_DM = {"dm_30809996c5a3820ea6769ff9", "dm_c600f2be065bb6be1daa3592",
            "dm_80f1a08048f813f76acaee40", "dm_4fd312fd9b762a49af52aed5",
            "dm_3d7c39ef", "dm_485bdc31", "dm_c965c8fe", "dm_24bea09f",
            "dm_a7ebe2df", "dm_9eb385b3", "dm_51a4e717d7bcb56cbda9cab3", "dm_4380621", "dm_ac95cf0149b3ebc27d6ec844", "dm_1d85380e14832edd95462e91", "dm_e1246f32",
            "dm_068432a379d2a906f1f0924a", "dm_718ccc7df67ef88741ce8696",            "dm_56ed3f12", "dm_c8845382", "dm_8d7ef55a", "dm_4894584cfa2b78f5ffb18e08",
            "dm_4ea5ac22b297e8689fa3bd8d", "dm_6177d072d98f022db7fc89e5", "dm_ad5cca9a3c9b6380b07ab498",
            "dm_803a6bff537991edcfc39a4b", "dm_aff8e5e730b9ad3f0c45d99e", "dm_3bdb8209c3c91ef9d0f9f03d",
            "dm_d7382761b619118962493114", "dm_1d93d42e5b9fa91d52dd40c9",
            "dm_865634edee2c7fa516f34b61", "dm_5baeb0f5cf85bbf5dbee0862",
            "dm_0aa9aad1a1a0fbfc5f9b44f0", "dm_693ac7b9f0e8699948c01244",
            "dm_1832d8ffb194cbf2f3423c70", "dm_8b05e93d5fd427c9a5c7528d",
            "dm_de63859f0d4870b0faf394fd", "dm_78e80842fbb4a6836d34d534", "dm_4cc6e0c6acc7377febd3f33d", "dm_28dee64067960ba045e8ab82",            "dm_80fc7f34b4d9450aa01ba6ff", "dm_2b6d8ccd0bc0334bf88339c1",
            "dm_6b66f7669fdb48febd06774f", "dm_d9e4aa4564733452ea857031",
            "dm_70f26dfbd76a86aa68ff373a", "dm_31e36bbf063a0102045d69f8",
            "dm_2384840c3f974d42fb835129", "dm_1de8181416d1da7a206ea7a6",
            "dm_dbbd22e701b67e6dd30c4ad9", "dm_8f6547303cdaff9981843691", "dm_0eacb9861acd03b43414b90d", "dm_7a1490b5773e2f595b36b3ac", "dm_50c1a5477b113c419e034fc5", "dm_3fb05125d42aa39690e36502"}

def http_json(url, method="GET", body=None, headers=None, timeout=25):
    h = dict(UA); h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    if method == "GET" and data is None:
        data = None
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except Exception as e:
        return {"_error": str(e)}

def rpc(url, method, params, retries=3):
    for _ in range(retries):
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            time.sleep(3)
    return None

def call(url, to, data):
    out = rpc(url, "eth_call", [{"to": to, "data": data}, "latest"])
    if not out or "error" in out: return None
    return out.get("result", "")

def owner_of(chain_url, aid):
    out = call(chain_url, IDENT, "0x6352211e" + hex(aid)[2:].zfill(64))
    if out and out.startswith("0x000000000000000000000000") and len(out) == 66:
        return "0x" + out[26:]
    return None

def get_bal(url, addr, token=None):
    if token:
        out = call(url, token, "0x70a08231" + "0" * 24 + addr[2:].lower())
    else:
        out = rpc(url, "eth_getBalance", [addr, "latest"])
        out = out.get("result") if out else None
    if not out: return None
    return int(out, 16) / 1e18 if len(out) > 2 else 0

def get_bal_raw(url, addr, token=None):
    """Raw balance (no division) — for 6-decimal USDC use /1e6."""
    if token:
        out = call(url, token, "0x70a08231" + "0" * 24 + addr[2:].lower())
    else:
        out = rpc(url, "eth_getBalance", [addr, "latest"])
        out = out.get("result") if out else None
    if not out: return None
    return int(out, 16) if len(out) > 2 else 0

BASE_RPCS = ["https://mainnet.base.org", "https://base.drpc.org"]
base_results = {}
for u in BASE_RPCS:
    ow = owner_of(u, AGENT_BASE)
    gw = call(u, IDENT, sel("getAgentWallet(uint256)") + hex(AGENT_BASE)[2:].zfill(64))
    gw = "0x" + gw[26:] if gw and gw.startswith("0x000000000000000000000000") and len(gw) == 66 else gw
    base_results[u] = {"ownerOf": ow, "getAgentWallet": gw}

eth_b = get_bal("https://mainnet.base.org", WALLET)
usdc_b = get_bal_raw("https://mainnet.base.org", WALLET, USDC_BASE)
usdc_b = usdc_b / 1e6 if usdc_b is not None else None
mon_b = get_bal("https://rpc.monad.xyz", WALLET)
usdc_m = get_bal_raw("https://rpc.monad.xyz", WALLET, USDC_MONAD := "0x754704Bc059F8C67012fEd69BC8A327a5aafb603")
usdc_m = usdc_m / 1e6 if usdc_m is not None else None

# --- Base Registered scan (8000 blocks, 100/chunk) ---
b = rpc("https://base.drpc.org", "eth_blockNumber", [])
latest = int(b["result"], 16) if b else None
TOPIC0 = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a"
uris, errs = [], 0
if latest:
    for i in range(80):
        start = latest - (i + 1) * 100
        r = rpc("https://base.drpc.org", "eth_getLogs", [{"fromBlock": hex(start), "toBlock": hex(start + 99),
                "address": IDENT, "topics": [TOPIC0]}])
        if r is None: errs += 1; continue
        for lg in r.get("result", []):
            aid = int(lg["topics"][1], 16) if len(lg.get("topics", [])) > 1 else 0
            data_hex = lg.get("data", "0x")[2:]
            uri = ""
            if len(data_hex) >= 128:
                off = int(data_hex[0:64], 16); ln = int(data_hex[off:off+64], 16)
                uri = bytes.fromhex(data_hex[off+64:off+64+ln*2]).decode("utf-8", "replace")
            uris.append((int(lg["blockNumber"], 16), aid, uri))
        time.sleep(0.3)

seen = {}
for blk, aid, uri in uris:
    k = uri.lower().strip()
    if any(s in k for s in SPAM): continue
    seen.setdefault(k, {"n": 0, "ids": set(), "blk": blk})
    seen[k]["n"] += 1; seen[k]["ids"].add(aid)

known_uris = {"validator.apexaistudio.app/.well-known/agent-card.json",
              "odilelabs.com/erc8004.json", "xhagents.xyz",
              "execution.market/.well-known/agent-card.json"}
new_uris = []
for k, v in seen.items():
    if k in known_uris or not k: continue
    u = k if k.startswith("http") else "https://" + k.lstrip("/")
    host = urllib.parse.urlparse(u).netloc.split("/")[0]
    if not host: continue
    try: socket.gethostbyname(host); dns = "OK"
    except Exception: new_uris.append({"uri": k, "ids": sorted(v["ids"]), "blk_ago": latest - v["blk"], "dns": "NXDOMAIN"}); continue
    card, a2a = False, None
    for path in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
        try:
            req = urllib.request.Request(u.rstrip("/") + path, headers={"User-Agent": UA["User-Agent"]})
            with urllib.request.urlopen(req, timeout=10) as r:
                card = json.load(r)
            break
        except Exception: continue
    if card:
        for iface in (card.get("interfaces") or []) + [card]:
            for ep in iface.get("transports") or [iface]:
                if "a2a" in (ep.get("url") or ""): a2a = ep.get("url")
    new_uris.append({"uri": k, "ids": sorted(v["ids"]), "blk_ago": latest - v["blk"], "dns": "OK",
                     "card": bool(card), "a2a": a2a})

# --- Monad frontier ---
monad_mints = []
for aid in range(10424, 10481):
    o = owner_of("https://rpc.monad.xyz", aid)
    if o:
        monad_mints.append((aid, o))
    time.sleep(0.12)
monad_frontier = monad_mints[-1][0] if monad_mints else 10423

# --- Taifoon hooks/work + readiness ---
taifoon_feed = http_json("https://coord.taifoon.dev/v1/hooks/work?classes=mcp.digest,data.transform,web.search")
taifoon_ready = http_json("https://coord.taifoon.dev/v1/agents/143/10331/readiness")
dm_ids, dm_new = [], []
rows = []
if isinstance(taifoon_feed, list):
    rows = taifoon_feed
elif isinstance(taifoon_feed, dict):
    rows = taifoon_feed.get("rows") or taifoon_feed.get("demands") or taifoon_feed.get("demands_open") or taifoon_feed.get("work") or []
for r_ in rows:
    if not isinstance(r_, dict): continue
    did = r_.get("id") or r_.get("demand_id") or r_.get("demand") or r_.get("dm")
    if did and did not in dm_ids:
        dm_ids.append(did)
        # prefix match: KNOWN_DM may hold truncated ids (dm_56ed3f12 style)
        if not any(did.startswith(k) or k.startswith(did) for k in KNOWN_DM):
            dm_new.append({"id": did, "cls": r_.get("class"), "created": r_.get("created_at") or r_.get("ts")})

# --- inbox SQLite Taifoon notices ---
notices = []
try:
    con = sqlite3.connect("file:/home/ubuntu/defigent-data/defigent_a2a.db?mode=ro", uri=True)
    cur = con.execute("SELECT ts, text FROM messages WHERE role='user' AND text LIKE 'Taifoon work notice.%' ORDER BY ts DESC LIMIT 10")
    for ts, text in cur:
        import re
        m = re.search(r"dm_[0-9a-f]{24}", text)
        if m and not any(m.group(0) == k or m.group(0).startswith(k) or k.startswith(m.group(0)) for k in KNOWN_DM):
            notices.append({"ts": ts, "dm": m.group(0)})
    con.close()
except Exception as e:
    notices = [{"_db_error": str(e)}]

# winner lookup for new dm ids
winner_info = []
import urllib.error
for d in list(dm_new) + notices:
    did = d.get("id") or d.get("dm")
    if not did or not did.startswith("dm_"): continue
    det = http_json("https://coord.taifoon.dev/v1/demands/" + did)
    if isinstance(det, dict) and "_error" not in det:
        dem = det.get("demand") if isinstance(det.get("demand"), dict) else det
        att = dem.get("attempts") or []
        win = {"dm": did, "n_attempts": len(att), "buyer_label": dem.get("buyer_label"),
               "class": (dem.get("classes") or dem.get("class"))}
        if att:
            a0 = att[0]
            win["seller"] = a0.get("seller")
            win["state"] = dem.get("state")
            end = dem.get("ending") or {}
            win["verdict"] = end.get("verdict"); win["tx"] = end.get("tx")
            win["attempts"] = [{"seller": a.get("seller"), "ts": a.get("ts") or a.get("created_at")} for a in att[:3]]
        else:
            win["state"] = det.get("state") or "open"
        winner_info.append(win)
    else:
        winner_info.append({"dm": did, "error": str(det)[:120]})

print(json.dumps({
    "base_identity": base_results,
    "balances": {"base_eth": eth_b, "base_usdc": usdc_b, "monad_mon": mon_b, "monad_usdc": usdc_m},
    "base_scan": {"latest": latest, "chunks_err": errs, "logs": len(uris), "non_spam": len(seen), "new": new_uris},
    "monad": {"new_mints": monad_mints, "frontier": monad_frontier},
    "taifoon": {"feed_raw_status": str(taifoon_feed)[:500], "ready": taifoon_ready, "dm_ids": dm_ids, "dm_new": dm_new},
    "inbox_notices": notices,
    "winners": winner_info,
}, indent=2))
RESULT = {
    "base_identity": base_results,
    "balances": {"base_eth": eth_b, "base_usdc": usdc_b, "monad_mon": mon_b, "monad_usdc": usdc_m},
    "base_scan": {"latest": latest, "chunks_err": errs, "logs": len(uris), "non_spam": len(seen), "new": new_uris},
    "monad": {"new_mints": monad_mints, "frontier": monad_frontier},
    "taifoon": {"ready": taifoon_ready, "dm_ids": dm_ids, "dm_new": dm_new},
    "inbox_notices": notices, "winners": winner_info,
}
print(json.dumps(RESULT, indent=2))
with open("/home/ubuntu/defigent-data/multichain_scan_07nov.json", "w") as f:
    json.dump({"ts": time.time(), **RESULT}, f, indent=2)
