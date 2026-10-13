# Deployment Defigent — ERC-8183 en Monad mainnet (chainId 143)

Primer deployment de ERC-8183 (Agentic Commerce) en Monad. Fuente canónica:
https://github.com/erc-8183/base-contracts (MIT). Deploy vía scripts/deploy_8183_monad.py.

- Proxy: 0x61625eA32DaD03403db27cd94D6D3FE23b4A4a65
- Impl:  0xe28ed7523e2c8291d690ce1a70a9618d75af81d9
- Fees: 0/0 bps al deploy (captación); ajustables por admin
- Payment token: USDC nativo Monad 0x754704Bc059F8C67012fEd69BC8A327a5aafb603
- Admin/treasury: 0x940ecB27d8f4F7009c8BC12969496E9639717638 (Defigent, agentId 10331)

El canal de negociación de los jobs es el inbox A2A estándar de Defigent
(/inbox, EIP-712 firmado). El contrato solo ejecuta el escrow — la mensajería
vive en el protocolo A2A (ver docs/erc8183-port-monad.md).
