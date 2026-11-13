#!/usr/bin/env python3
"""Defigent — compra de gas para Base vía Layerswap (LI.FI): 1.5 USDC(Monad) → ~0.0006 ETH(Base).
   El solver paga el gas destino. Aprobación nueva al router (anterior consumida por el bridge de 5 USDC)."""
import json, os, time, urllib.request
from eth_account import Account
from eth_utils import keccak

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
RPC = env['QUICKNODE_URL']
W = env.get('DEFIGENT_ADDRESS') or '0x940ecB27d8f4F7009c8BC12969496E9639717638'
USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
AMT = 1_500_000  # 1.5 USDC

def rpc(m, p):
    req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if 'result' not in r: raise RuntimeError(str(r.get('error', r))[:200])
    return r['result']

url = (f'https://li.quest/v1/quote?fromChain=143&toChain=8453'
       f'&fromToken={USDC}&toToken=0x0000000000000000000000000000000000000000'
       f'&fromAmount={AMT}&fromAddress={W}&toAddress={W}')
q = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read())
tool = q['toolDetails']['name']
spender = q['transactionRequest']['to']
data = q['transactionRequest']['data']
to_eth = float(q['estimate']['toAmount']) / 1e18
print(f'ruta {tool} | recibiré ~{to_eth:.7f} ETH en Base | spender {spender}')

acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
nonce = int(rpc('eth_getTransactionCount', [W, 'pending']), 16)
gp = int(rpc('eth_gasPrice', []), 16)
enc = lambda n: hex(n)[2:].zfill(64)

def send(tx):
    s = acct.sign_transaction(tx)
    raw = s.raw_transaction.hex()
    return rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])

def wait(h, label):
    for _ in range(45):
        time.sleep(3)
        rec = rpc('eth_getTransactionReceipt', [h])
        if rec and rec.get('blockNumber'):
            print(f'{label}: status={rec["status"]} gas={int(rec["gasUsed"],16)} block={int(rec["blockNumber"],16)}')
            return rec['status'] == '0x1'
    return False

ad = '0x' + keccak(text='approve(address,uint256)').hex()[:8] + spender[2:].lower().zfill(64) + enc(2_000_000)
g = int(rpc('eth_estimateGas', [{'from': W, 'to': USDC, 'data': ad, 'value': '0x0'}]), 16)
h1 = send({'nonce': nonce, 'gasPrice': gp, 'gas': g, 'to': USDC, 'value': 0, 'data': ad, 'chainId': 143})
print('approve tx:', h1)
if not wait(h1, 'approve'): raise SystemExit('approve falló')
nonce += 1

g2 = int(rpc('eth_estimateGas', [{'from': W, 'to': spender, 'data': data, 'value': '0x0'}]), 16)
h2 = send({'nonce': nonce, 'gasPrice': gp, 'gas': min(g2 * 12 // 10, 900000), 'to': spender, 'value': 0, 'data': data, 'chainId': 143})
print('swap tx:', h2)
ok = wait(h2, 'swap')
print('LISTO — verificar ETH en Base en ~1-2 min' if ok else 'pendiente, verificar luego')
