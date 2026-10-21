#!/usr/bin/env python3
"""Defigent — setAgentWallet + setAgentURI para agentId 114426 en Base."""
import json, os, time, base64, urllib.request
from eth_account import Account
from eth_utils.address import to_checksum_address
from eth_utils import keccak

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
W = to_checksum_address(env.get('DEFIGENT_ADDRESS') or '0x940ecB27d8f4F7009c8BC12969496E9639717638')
IDENT = to_checksum_address('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
AGENT_ID = 114426
HTTPS = 'https://opacus-liana-lanceted.ngrok-free.dev'

def rpc(m, p):
    req = urllib.request.Request('https://base.drpc.org', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)'})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if 'result' not in r: raise RuntimeError(str(r.get('error', r))[:200])
    return r['result']

sel = lambda sig: '0x' + keccak(text=sig).hex()[:8]
enc32 = lambda n: hex(n)[2:].zfill(64)
enc_str = lambda s: enc32(32) + enc32(len(s)) + s.encode().hex() + '00' * ((-len(s)) % 32)

registration = {
    'type': 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    'name': 'Defigent',
    'description': 'A2A inbox with EIP-712 signed identity, x402 payments and on-chain agent directory. Monad mainnet agentId 10331, expanding to Base. Digest services, network discovery, taskful messaging (streaming, ListTasks, artifacts).',
    'image': None,
    'services': [
        {'name': 'A2A', 'endpoint': HTTPS + '/inbox', 'version': '1.0.1'},
        {'name': 'inbox', 'endpoint': HTTPS + '/inbox', 'version': '1.0.1'},
        {'name': 'mcp', 'endpoint': HTTPS + '/mcp', 'version': '2026-07-28'},
        {'name': 'status', 'endpoint': HTTPS + '/status', 'version': '1'},
        {'name': 'network', 'endpoint': HTTPS + '/network', 'version': '1'},
        {'name': 'integration', 'endpoint': HTTPS + '/integration', 'version': '1'},
    ],
    'x402Support': True,
    'x402': {'rail': 'x402', 'facilitator': 'https://x402-facilitator.molandak.org', 'network': 'eip155:143'},
    'supportedTrust': ['eip-8004#trustless-agents-v1'],
    'agentWallet': W,
}
uri = 'data:application/json;base64,' + base64.b64encode(json.dumps(registration, separators=(',', ':')).encode()).decode()

acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
nonce = int(rpc('eth_getTransactionCount', [W, 'pending']), 16)
blk = rpc('eth_getBlockByNumber', ['latest', False])
base_fee = int(blk['baseFeePerGas'], 16)
max_prio, max_fee = max(10**8, base_fee), base_fee * 3 + max(10**8, base_fee)

def send_and_wait(data, label, gas=1_500_000):
    global nonce
    tx = {'nonce': nonce, 'maxFeePerGas': max_fee, 'maxPriorityFeePerGas': max_prio, 'gas': gas,
          'to': IDENT, 'value': 0, 'data': data, 'chainId': 8453, 'type': 2}
    s = acct.sign_transaction(tx)
    raw = s.raw_transaction.hex()
    h = rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])
    print(f'{label} tx: {h}')
    nonce += 1
    for _ in range(30):
        time.sleep(3)
        try:
            rec = rpc('eth_getTransactionReceipt', [h])
        except Exception:
            continue
        if rec and rec.get('blockNumber'):
            st, gu = rec['status'], int(rec['gasUsed'], 16)
            print(f'{label}: status={st} gas={gu} block={int(rec["blockNumber"],16)}')
            return st == '0x1'
    print(f'{label}: sin receipt'); return False

ok1 = send_and_wait(sel('setAgentWallet(uint256,address)') + enc32(AGENT_ID) + W[2:].lower().zfill(64), 'setAgentWallet')
ok2 = send_and_wait(sel('setAgentURI(uint256,string)') + enc32(AGENT_ID) + enc_str(uri), 'setAgentURI')
print('RESULTADO:', 'OK ambos' if ok1 and ok2 else f'wallet={ok1} uri={ok2}')
