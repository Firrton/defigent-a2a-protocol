#!/usr/bin/env python3
"""Defigent — follow-up a los agentes A2A vivos (tanda 2, sin pedir address).

Cambio vs simple_offer_alive.py:
  * cero-fricción: la única acción pedida es RESPONDER (A/B/C)
  * ruta de respuesta EXPLÍCITA (https://defigent.app/inbox + ejemplo JSON-RPC)
    — la oferta anterior decía "reply to THIS inbox" sin decirnos CÓMOS alcanzarnos
  * address opcional, solo al cobrar
"""
import json, urllib.request, time, sys

BATCH = int(sys.argv[1]) if len(sys.argv) > 1 else 50
SKIP = int(sys.argv[2]) if len(sys.argv) > 2 else 0
_data = json.load(open('/home/ubuntu/defigent-data/taifoon_a2a_alive.json'))
rows = _data['rows'] if isinstance(_data, dict) and 'rows' in _data else _data

EXAMPLE = ('{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"agent",'
           '"sender":"<your-agent-id>","parts":[{"text":"B"}],"messageId":"<unique-id>","kind":"message"}}}')
FOLLOWUP = (
    "Following up on our earlier message — this time the ask is smaller: NO wallet, "
    "NO address, just an answer.\n\n"
    "Question for your agent: when you take an on-chain job, what matters most?\n"
    "  (A) escrow that cannot rug\n"
    "  (B) on-chain reputation that compounds (ERC-8004)\n"
    "  (C) payment speed\n"
    "Reply with A, B or C — or anything else.\n\n"
    "How to reply: POST an A2A 1.0.1 message to https://defigent.app/inbox, e.g.\n"
    + EXAMPLE + "\n\n"
    "After you reply, want the paid trial: we fund 0.5 MON gas + a 0.10 USDC ERC-8183 "
    "job on Monad (0% fees, automatic ERC-8004 attestation). You share an address only "
    "when claiming the payout — never before.\n\n"
    "\u2014 Defigent \u00b7 ERC-8004 agentId 10331 (Monad) / 114426 (Base) \u00b7 https://defigent.app"
)

sent, fails = 0, []
for a in rows[SKIP:SKIP + BATCH]:
    url = (a.get('url') or '').rstrip('/')
    if not url.startswith('http'):
        continue
    mid = "defigent-followup-{}-{}".format(str(a.get('id', 'x'))[:8], int(time.time()))
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "message/send",
                       "params": {"message": {"role": "agent",
                                              "sender": "0x940ecB27d8f4F7009c8BC12969496E9639717638",
                                              "parts": [{"text": FOLLOWUP}],
                                              "messageId": mid, "kind": "message"}}}).encode()
    try:
        req = urllib.request.Request(url, body, {'Content-Type': 'application/json',
                                                 'A2A-Version': '1.0.1',
                                                 'User-Agent': 'Mozilla/5.0'})
        r = urllib.request.urlopen(req, timeout=15)
        st = '?'
        try:
            st = json.loads(r.read()).get('result', {}).get('task', {}).get('status', {}).get('state', '?')
        except Exception:
            pass
        print("  {:26} -> {} {}".format(str(a.get('name', '?'))[:24], r.status, st))
        sent += 1
    except Exception as e:
        fails.append(str(a.get('name')))
        print("  {:26} -> FAIL {}".format(str(a.get('name', '?'))[:24], str(e)[:50]))
    time.sleep(1.2)
print("\nfollow-ups enviados: {} | fallos: {}".format(sent, len(fails)))