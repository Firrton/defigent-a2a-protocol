#!/usr/bin/env python3
"""Defigent — deploy ERC-8183 (escrow agéntico) en Monad mainnet: impl UUPS + proxy ERC1967
   con initialize(treasury, admin) = nuestra wallet. Primer deployment ERC-8183 en Monad."""
import json, os, sys, time, urllib.request
from eth_account import Account
from eth_utils import keccak

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
RPC = env['QUICKNODE_URL']
W = env.get('DEFIGENT_ADDRESS') or '0x940ecB27d8f4F7009c8BC12969496E9639717638'
USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
REPO = os.path.expanduser('~/defigent-mcp/contracts-8183')

def rpc(m, p):
    req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if 'result' not in r: raise RuntimeError(str(r.get('error', r))[:200])
    return r['result']

acct = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
nonce = int(rpc('eth_getTransactionCount', [W, 'pending']), 16)
gp = int(rpc('eth_gasPrice', []), 16)
print(f'gasPrice: {gp/1e9:.1f} gwei | nonce: {nonce}')

def send(data, label, gas):
    global nonce
    tx = {'nonce': nonce, 'gasPrice': gp, 'gas': gas, 'to': None, 'value': 0, 'data': data, 'chainId': 143}
    s = acct.sign_transaction(tx)
    raw = s.raw_transaction.hex()
    h = rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])
    print(f'{label} tx: {h}')
    nonce += 1
    for _ in range(40):
        time.sleep(3)
        rec = rpc('eth_getTransactionReceipt', [h])
        if rec and rec.get('blockNumber'):
            addr = rec.get('contractAddress')
            print(f'{label}: status={rec["status"]} gas={int(rec["gasUsed"],16)} block={int(rec["blockNumber"],16)} address={addr}')
            if rec['status'] != '0x1': raise SystemExit(f'{label} FALLÓ')
            return addr
    raise SystemExit(f'{label}: sin receipt')

# 1) impl (skip si ya está deployado — estado en /tmp/erc8183_state.json)
state_path = '/tmp/erc8183_state.json'
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
art = json.load(open(f'{REPO}/out/ERC8183.sol/ERC8183.json'))
impl_bc = art['bytecode']['object']
if not impl_bc.startswith('0x'): impl_bc = '0x' + impl_bc
if state.get('impl'):
    IMPL = state['impl']
    print('impl ya deployado:', IMPL, '— reutilizando')
else:
    IMPL = send(impl_bc, 'impl ERC8183', 9_000_000)
    json.dump({'impl': IMPL}, open(state_path, 'w'))

# 2) proxy ERC1967Proxy(impl, initData) — bytes dinámico con ABI correcto
W_cs = '0x940ecB27d8f4F7009c8BC12969496E9639717638'
init = '0x' + keccak(text='initialize(address,address)').hex()[:8] + W_cs[2:].lower().zfill(64) + W_cs[2:].lower().zfill(64)
proxy_art = json.load(open(f'{REPO}/out/ERC1967Proxy.sol/ERC1967Proxy.json'))
proxy_bc = proxy_art['bytecode']['object']
if not proxy_bc.startswith('0x'): proxy_bc = '0x' + proxy_bc
init_hex = init[2:]
ctor_args = (IMPL[2:].zfill(64) + (64).to_bytes(32, 'big').hex()
             + (len(init_hex) // 2).to_bytes(32, 'big').hex()
             + init_hex + '00' * ((-len(init_hex)) % 32))
PROXY = send(proxy_bc + ctor_args, 'proxy ERC1967', 600_000)
json.dump({'impl': IMPL, 'proxy': PROXY}, open(state_path, 'w'))

# 3) allowlist USDC nativo Monad (admin)
sel = keccak(text='setPaymentTokenAllowed(address,bool)').hex()[:8]
data = '0x' + sel + USDC[2:].lower().zfill(64) + '01'.zfill(64)
tx = {'nonce': nonce, 'gasPrice': gp, 'gas': 100000, 'to': PROXY, 'value': 0, 'data': data, 'chainId': 143}
s = acct.sign_transaction(tx); raw = s.raw_transaction.hex()
h = rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])
print('allowlist tx:', h); nonce += 1
ok = False
for _ in range(40):
    time.sleep(3)
    rec = rpc('eth_getTransactionReceipt', [h])
    if rec and rec.get('blockNumber'):
        print(f'allowlist: status={rec["status"]} gas={int(rec["gasUsed"],16)}')
        ok = rec['status'] == '0x1'; break

# 4) verificación on-chain
chk = lambda sig: '0x' + keccak(text=sig).hex()[:8]
pf = rpc('eth_call', [{'to': PROXY, 'data': chk('platformFeeBP()')}, 'latest'])
ef = rpc('eth_call', [{'to': PROXY, 'data': chk('evaluatorFeeBP()')}, 'latest'])
tr = rpc('eth_call', [{'to': PROXY, 'data': chk('platformTreasury()')}, 'latest'])
adm = rpc('eth_call', [{'to': PROXY, 'data': chk('hasRole(bytes32,address)')[0:10]} if False else {'to': PROXY, 'data': '0x' + keccak(text='platformFeeBP()').hex()[:8]}, 'latest'])
allowed = rpc('eth_call', [{'to': PROXY, 'data': chk('allowedPaymentTokens(address)') + USDC[2:].lower().zfill(64)}, 'latest'])
print(f'\nVERIFICADO on-chain: platformFeeBP={int(pf,16)} evaluatorFeeBP={int(ef,16)} treasury=0x{tr[-40:]} USDC_allowed={int(allowed,16)==1}')
print(f'\nPROXY (usar este): {PROXY}\nIMPL: {IMPL}')
