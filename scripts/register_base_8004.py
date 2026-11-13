#!/usr/bin/env python3
"""Defigent — registro ERC-8004 en BASE con URI corto (https card). Intento 3 tras 2 reverts con data:URI largo."""
import json, os, time, urllib.request
from eth_account import Account
from eth_utils.address import to_checksum_address
from eth_utils import keccak

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
W = to_checksum_address(env.get('DEFIGENT_ADDRESS') or '0x940ecB27d8f4F7009c8BC12969496E9639717638')
IDENT = to_checksum_address('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
URI = 'https://opacus-liana-lanceted.ngrok-free.dev/.well-known/agent-card.json'

def rpc(m, p):
    req = urllib.request.Request('https://mainnet.base.org', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)'})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if 'result' not in r: raise RuntimeError(str(r.get('error', r))[:200])
    return r['result']

sel = lambda sig: '0x' + keccak(text=sig).hex()[:8]
enc32 = lambda n: hex(n)[2:].zfill(64)
enc_str = lambda s: enc32(32) + enc32(len(s)) + s.encode().hex() + '00' * ((-len(s)) % 32)

blk = rpc('eth_getBlockByNumber', ['latest', False])
base_fee = int(blk['baseFeePerGas'], 16)
max_prio = max(10**8, base_fee)
max_fee = base_fee * 3 + max_prio
bal = int(rpc('eth_getBalance', [W, 'latest']), 16)
print(f'balance: {bal/1e18:.6f} ETH | baseFee {base_fee/1e9:.4f} gwei')
acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
nonce = int(rpc('eth_getTransactionCount', [W, 'pending']), 16)

data = sel('register(string)') + enc_str(URI)
tx = {'nonce': nonce, 'maxFeePerGas': max_fee, 'maxPriorityFeePerGas': max_prio, 'gas': 1_200_000,
      'to': IDENT, 'value': 0, 'data': data, 'chainId': 8453, 'type': 2}
s = acct.sign_transaction(tx)
raw = s.raw_transaction.hex()
h = rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])
print('register tx:', h)
for _ in range(30):
    time.sleep(3)
    rec = rpc('eth_getTransactionReceipt', [h])
    if rec and rec.get('blockNumber'):
        r = rec['result']
        st, gu = r['status'], int(r['gasUsed'], 16)
        print(f'register: status={st} gas={gu} block={int(r["blockNumber"],16)}')
        if st != '0x1': raise SystemExit('REVERT de nuevo — diagnosticar distinto')
        agent_id = None
        for lg in r.get('logs', []):
            t = lg.get('topics', [])
            if len(t) >= 4 and t[0].lower() == ('0x' + keccak(text='Transfer(address,address,uint256)').hex()):
                agent_id = int(t[3], 16)
        print('agentId BASE:', agent_id)
        break
else:
    raise SystemExit('sin receipt')
