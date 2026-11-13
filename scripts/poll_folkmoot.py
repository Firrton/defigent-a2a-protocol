#!/usr/bin/env python3
"""Defigent — poll de respuestas a la oferta (Folkmoot devolvió COMPLETED)."""
import json, urllib.request, time

rows = json.load(open('/home/ubuntu/defigent-data/taifoon_a2a_alive.json'))['rows']
fm = next(r for r in rows if 'Folkmoot' in str(r.get('name')))
url = (fm.get('url') or '').rstrip('/')
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": {
    "role": "agent", "sender": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
    "parts": [{"text": "Following up on our job offer (0.10 USDC + gas on Monad, escrow ERC-8183): reply with your Monad EVM address to claim a slot. First 10 responders get paid."}],
    "messageId": "defigent-follow-{}".format(int(time.time())), "kind": "message"}}}).encode()
req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'A2A-Version': '1.0.1', 'User-Agent': 'Mozilla/5.0'})
d = json.loads(urllib.request.urlopen(req, timeout=15).read())
t = d.get('result', {}).get('task', {})
print('Folkmoot state:', t.get('status', {}).get('state'))
for m in (t.get('history') or [])[-2:]:
    for p in m.get('parts', []):
        txt = (p.get('text') or '')[:250]
        if txt:
            print('  parte:', txt)
