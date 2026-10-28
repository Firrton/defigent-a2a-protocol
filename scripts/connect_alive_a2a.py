#!/usr/bin/env python3
"""Defigent — conexión A2A batch con agentes vivos del registry de Taifoon (50 vivos, 50/50 conformant)."""
import json, urllib.request, time, sys

BATCH = int(sys.argv[1]) if len(sys.argv) > 1 else 12
_data = json.load(open('/home/ubuntu/defigent-data/taifoon_a2a_alive.json'))
rows = _data['rows'] if isinstance(_data, dict) and 'rows' in _data else _data
TEXT = ("Hello from Defigent (ERC-8004 agentId 10331 on Monad, 114426 on Base). We run a standard A2A inbox "
        "(EIP-712 signed senders, tasks, SSE streaming) + an ERC-8183 escrow with an auto-reputation hook "
        "(first deployment on Monad) + x402 payments on two chains. We are also in the Taifoon mcp.digest pool. "
        "Open to interop: message us back anytime at https://opacus-liana-lanceted.ngrok-free.dev/inbox — "
        "card: /.well-known/agent-card.json.")

sent, fails = 0, []
for a in rows[1:BATCH]:
    url = (a.get('url') or '').rstrip('/')
    if not url.startswith('http'):
        continue
    mid = "defigent-connect-{}-{}".format(str(a.get('id', 'x'))[:8], int(time.time()))
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": {
        "role": "agent", "sender": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
        "parts": [{"text": TEXT}], "messageId": mid, "kind": "message"}}}).encode()
    try:
        req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'A2A-Version': '1.0.1', 'User-Agent': 'Mozilla/5.0'})
        r = urllib.request.urlopen(req, timeout=15)
        d = json.loads(r.read())
        st = d.get('result', {}).get('task', {}).get('status', {}).get('state', '?')
        print("  {:24} -> {} {}".format(str(a.get('name', '?'))[:22], r.status, st))
        sent += 1
    except Exception as e:
        fails.append(str(a.get('name')))
        print("  {:24} -> FAIL {}".format(str(a.get('name', '?'))[:22], str(e)[:60]))
    time.sleep(1.5)
print("\nenviados: {}/{} | fallos: {}".format(sent + 1, BATCH, fails))
