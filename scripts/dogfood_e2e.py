#!/usr/bin/env python3
"""Defigent — dogfood E2E con la wallet provider B (0x54d3…, agentId 10407).
Ciclo: client crea job → asigna provider B → fondea → B submita el hash → client complete → escrow paga a B.
Gas a B: 0.3 MON. Budget: 0.05 USDC."""
import json, os, time, urllib.request
from eth_account import Account
from eth_utils import keccak, to_checksum_address
from eth_abi import encode as abi_encode

env = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.hermes/.env')) if '=' in l and not l.startswith('#'))
RPC = env['QUICKNODE_URL']
PROXY = to_checksum_address('0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65')
USDC = to_checksum_address('0x754704Bc059F8C67012fEd69BC8A327a5aafb603')
client = Account.from_key(env['DEFIGENT_PRIVATE_KEY'])
B = Account.from_key(json.load(open('/tmp/defigent_provider_key.json'))['key'])
GP = 300_000_000_000  # 300 gwei fijo — evita el fee floor dinámico
GAS = 3_000_000

def rpc(m, p):
    req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                 {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    r = json.loads(urllib.request.urlopen(req, timeout=40).read())
    if 'error' in r: raise RuntimeError(str(r['error'])[:150])
    return r['result']

def send(acct, to, data, value=0, gas=GAS):
    nonce = int(rpc('eth_getTransactionCount', [acct.address, 'pending']), 16)
    tx = {'nonce': nonce, 'gasPrice': GP, 'gas': gas, 'chainId': 143, 'to': to, 'value': value, 'data': data}
    s = acct.sign_transaction(tx)
    raw = s.raw_transaction.hex()
    h = rpc('eth_sendRawTransaction', [raw if raw.startswith('0x') else '0x' + raw])
    for _ in range(40):
        time.sleep(2)
        rec = rpc('eth_getTransactionReceipt', [h])
        if rec and rec.get('blockNumber'):
            if rec['status'] != '0x1': raise RuntimeError('REVERT ' + h)
            return h, int(rec['gasUsed'], 16)
    raise RuntimeError('timeout ' + h)

def enc(sig, types, vals):
    return '0x' + keccak(text=sig).hex()[:8] + abi_encode(types, vals).hex()

W = client.address
print('client:', W, '| provider B:', B.address)

# 1. gas a B (0.8 MON — el setBudget con gas fijo 3M @300gwei cuesta ~0.9 MON de cap)
h, gu = send(client, B.address, '0x', 800_000_000_000_000_000, 21000)
print('gas a B: 0x1', 'gas', gu)

# 2. crear job (provider ABIERTO, evaluator = client, hook reputación)
desc = 'DOGFOOD JOB B: return the keccak256 hex digest of the exact UTF-8 text "defigent-dogfood-b-2". Budget: 0.05 USDC.'
exp = int(time.time()) + 7200
h, gu = send(client, PROXY, enc('createJob(address,address,uint48,string,address,uint256)',
    ['address','address','uint48','string','address','uint256'],
    ['0x' + '0'*40, W, exp, desc, to_checksum_address('0x03d516e52fd64e2d19a817498f941d7dea452cd6'), 0]), gas=800_000)
print('createJob: 0x1 gas', gu)

cnt = int(rpc('eth_call', [{'to': PROXY, 'data': '0x' + keccak(text='jobCounter()').hex()[:8]}, 'latest']), 16)
jid = cnt  # el último creado
print('jobId:', jid)

# 3. setProvider(B, agentId 10407)
h, gu = send(client, PROXY, enc('setProvider(uint256,address,uint256)', ['uint256','address','uint256'], [jid, B.address, 10407]), gas=300_000)
print('setProvider: 0x1 gas', gu)

# 4. B setea budget 0.05 USDC
h, gu = send(B, PROXY, enc('setBudget(uint256,address,uint256,bytes)', ['uint256','address','uint256','bytes'], [jid, USDC, 50000, b'']), gas=3_000_000)
print('provider setBudget: 0x1 gas', gu)

# 5. client approve + fund
h, gu = send(client, USDC, enc('approve(address,uint256)', ['address','uint256'], [PROXY, 50000]), gas=200_000)
print('approve: 0x1 gas', gu)
h, gu = send(client, PROXY, enc('fund(uint256,address,uint256,bytes)', ['uint256','address','uint256','bytes'], [jid, USDC, 50000, b'']), gas=800_000)
print('fund: 0x1 gas', gu)

# 6. B submita el deliverable
digest = keccak(text='defigent-dogfood-b-2')
h, gu = send(B, PROXY, enc('submit(uint256,bytes32,bytes)', ['uint256','bytes32','bytes'], [jid, digest, b'']), gas=800_000)
print('provider submit: 0x1 gas', gu)

# 7. client complete → paga a B + hook attesta reputación
h, gu = send(client, PROXY, enc('complete(uint256,bytes32,bytes)', ['uint256','bytes32','bytes'], [jid, digest, b'']), gas=1_500_000)
print('complete: 0x1 gas', gu)
print('✅ DOGFOOD E2E COMPLETO — jobId', jid, '| B cobró 0.05 USDC + reputación escrita por el hook')
json.dump({'jobId': jid, 'worker': B.address}, open('/tmp/dogfood_result.json', 'w'))
