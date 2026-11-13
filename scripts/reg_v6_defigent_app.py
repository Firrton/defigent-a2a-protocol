#!/usr/bin/env python3
"""Defigent — actualización del registro ERC-8004 (setAgentURI) a la v6 — endpoints defigent.app (Cloudflare):
   1 inbox canónico HTTPS + MCP streamable-http + address bound. Monad mainnet (143)."""
import json, os, time, base64, urllib.request
from eth_account import Account
from eth_utils.address import to_checksum_address
from eth_abi.abi import encode as abi_encode

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
RPC = env['QUICKNODE_URL']
WALLET = to_checksum_address(env.get('DEFIGENT_ADDRESS') or '0x940ecB27d8f4F7009c8BC12969496E9639717638')
IDENTITY = to_checksum_address('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
AGENT_ID = 10331
HTTPS = 'https://defigent.app'

def rpc(m, p):
    req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    r = json.loads(urllib.request.urlopen(req, timeout=25).read())
    if 'result' not in r: raise RuntimeError(json.dumps(r.get('error', r))[:200])
    return r['result']

# ---- registration file v4 ----
registration = {
    'type': 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    'name': 'Defigent',
    'description': 'Agentic commerce specialist agent on Monad: on-chain wallet digests, agent directory lookup, and regime analytics. ERC-8004 agentId 10331. Talks and pays x402 (v1+v2). Runs the only live standard A2A inbox on Monad — EIP-712 signed senders, stateful tasks, SSE streaming, ListTasks, extended card, trust on-chain.',
    'image': None,
    'services': [
        {'name': 'A2A', 'endpoint': HTTPS + '/inbox', 'version': '1.0.1'},
        {'name': 'inbox', 'endpoint': HTTPS + '/inbox', 'version': '1.0.1'},
        {'name': 'mcp', 'endpoint': HTTPS + '/mcp', 'version': '2026-07-28'},
        {'name': 'status', 'endpoint': HTTPS + '/status', 'version': '1'},
        {'name': 'network', 'endpoint': HTTPS + '/network', 'version': '1'},
        {'name': 'integration', 'endpoint': HTTPS + '/integration', 'version': '1'},
        {'name': 'jobs', 'endpoint': 'eip155:143:0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65', 'version': 'erc-8183'},
        {'name': 'x402-base', 'endpoint': 'eip155:8453', 'version': 'x402'},
    ],
    'x402Support': True,
    'x402': {'rail': 'x402', 'facilitator': 'https://x402-facilitator.molandak.org', 'network': 'eip155:143', 'facilitatorBase': 'https://facilitator.payai.network', 'networkBase': 'eip155:8453'},
    'supportedTrust': ['eip-8004#trustless-agents-v1'],
    'agentWallet': WALLET,
}
uri = 'data:application/json;base64,' + base64.b64encode(json.dumps(registration, separators=(',', ':')).encode()).decode()
print('URI length:', len(uri))

acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
nonce = int(rpc('eth_getTransactionCount', [WALLET, 'pending']), 16)
gp = int(rpc('eth_gasPrice', []), 16)
print(f'gasPrice: {gp//10**9} gwei | nonce: {nonce}')
if gp > 300 * 10**9:
    raise SystemExit('gasPrice > 300 gwei — abortando')

# setAgentURI(uint256 agentId, string agentURI) — ABI offset de string dinámico: 0x40 (2 head words)
data = ('0x' + __import__('eth_utils').keccak(text='setAgentURI(uint256,string)').hex()[:8]
        + hex(AGENT_ID)[2:].zfill(64)
        + (32 * 2).to_bytes(32, 'big').hex()
        + len(uri).to_bytes(32, 'big').hex()
        + uri.encode().hex()
        + '00' * ((-len(uri)) % 32))
tx = {'nonce': nonce, 'gasPrice': gp, 'gas': 300000, 'to': IDENTITY, 'value': 0, 'data': data, 'chainId': 143}
print('data len:', len(data), '| even:', len(data) % 2 == 0, '| head:', data[:10])
gas = int(rpc('eth_estimateGas', [{'from': WALLET, 'to': IDENTITY, 'data': data, 'value': '0x0'}]), 16)
print(f'gas estimado: {gas}')
tx['gas'] = gas
signed = acct.sign_transaction(tx)
raw = signed.raw_transaction.hex()
if not raw.startswith('0x'): raw = '0x' + raw
h = rpc('eth_sendRawTransaction', [raw])
print('tx:', h)
for _ in range(30):
    time.sleep(2)
    rec = rpc('eth_getTransactionReceipt', [h])
    if rec and rec.get('blockNumber'):
        print('status:', rec['status'], '| gasUsed:', int(rec['gasUsed'], 16), '| block:', int(rec['blockNumber'], 16))
        break
else:
    print('pending (sin receipt en 60s)')
