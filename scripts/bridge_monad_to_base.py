#!/usr/bin/env python3
"""Defigent — bridge 5 USDC Monad→Base vía LI.FI (ruta Polymer), autorizado por el usuario 13/14-oct.
   Deja intacto: gas Monad (~86 MON), 6.4 USDC restantes, 695.9 sMON (Kintsu)."""
import json, os, time, urllib.request
from eth_account import Account
from eth_utils import keccak

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
RPC = env['QUICKNODE_URL']
W = env.get('DEFIGENT_ADDRESS') or '0x940ecB27d8f4F7009c8BC12969496E9639717638'
USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
import sys
AMT = int(sys.argv[1]) if len(sys.argv) > 1 else 5_000_000  # micro-USDC (default 5 USDC)
CHAIN_MONAD, CHAIN_BASE = 143, 8453

def rpc(m, p):
    req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if 'result' not in r: raise RuntimeError(str(r.get('error', r))[:200])
    return r['result']

def send_tx(tx):
    acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
    signed = acct.sign_transaction(tx)
    raw = signed.raw_transaction.hex()
    return rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])

def wait_receipt(h, label, tries=45):
    for _ in range(tries):
        time.sleep(3)
        rec = rpc('eth_getTransactionReceipt', [h])
        if rec and rec.get('blockNumber'):
            st, gu = rec['status'], int(rec['gasUsed'], 16)
            print(f'{label}: status={st} gas={gu} block={int(rec["blockNumber"],16)} tx={h}')
            return st == '0x1'
    print(f'{label}: sin receipt tras {tries*3}s'); return False

# 1) quote fresco
url = (f'https://li.quest/v1/quote?fromChain={CHAIN_MONAD}&toChain={CHAIN_BASE}'
       f'&fromToken={USDC}&toToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
       f'&fromAmount={AMT}&fromAddress={W}&toAddress={W}')
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
q = json.loads(urllib.request.urlopen(req, timeout=30).read())
spender = q['transactionRequest']['to']
data = q['transactionRequest']['data']
to_amt = int(q['estimate']['toAmount'])/1e6
dur = q['estimate']['executionDuration']
print(f"ruta {q['toolDetails']['name']} | recibiré {to_amt:.6f} USDC en Base | ~{dur}s | spender {spender}")

acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
nonce = int(rpc('eth_getTransactionCount', [W, 'pending']), 16)
gp = int(rpc('eth_gasPrice', []), 16)

# 2) approve
enc = lambda n: hex(n)[2:].zfill(64)
approve_data = '0x' + keccak(text='approve(address,uint256)').hex()[:8] + spender[2:].lower().zfill(64) + enc(5_500_000)
tx1 = {'nonce': nonce, 'gasPrice': gp, 'gas': 100000, 'to': USDC, 'value': 0, 'data': approve_data, 'chainId': 143}
gas1 = int(rpc('eth_estimateGas', [{'from': W, 'to': USDC, 'data': approve_data, 'value': '0x0'}]), 16)
tx1['gas'] = gas1
h1 = send_tx(tx1)
print('approve tx:', h1)
if not wait_receipt(h1, 'approve'): raise SystemExit('approve falló — abortando')
nonce += 1

# 3) bridge tx (datos de la quote)
bridge = {'nonce': nonce, 'gasPrice': gp, 'gas': 700000, 'to': spender, 'value': 0, 'data': data, 'chainId': 143}
gas2 = int(rpc('eth_estimateGas', [{'from': W, 'to': spender, 'data': data, 'value': '0x0'}]), 16)
bridge['gas'] = min(gas2 * 12 // 10, 900000)
h2 = send_tx(bridge)
print('bridge tx:', h2)
if wait_receipt(h2, 'bridge'):
    print(f'RESULTADO: bridge enviado. Esperar ~{dur}s y verificar USDC en Base.')
else:
    print('bridge pendiente — verificar luego con tx:', h2)
