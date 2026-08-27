#!/usr/bin/env bash
set -euo pipefail

DUE_MSAT=21000000
FEE_MSAT=157500
WRAP_MSAT=$((DUE_MSAT + FEE_MSAT))
CHANNEL_SAT=1000000
TOP_UP_SAT=400000

bitcoind() { docker exec wrap-chain bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass "$@"; }
chain() { bitcoind -rpcwallet=reg "$@"; }
payer() { docker exec wrap-payer lncli --lnddir=/home/lnd/.lnd -n regtest "$@"; }
wrapper() { docker exec wrap-wrapper lncli --lnddir=/home/lnd/.lnd -n regtest "$@"; }
payee() { docker exec wrap-payee lightning-cli --lightning-dir=/home/clightning/.lightning --network=regtest "$@"; }

say() { printf '\n=== %s\n' "$*"; }

await() {
  local label=$1 tries=$2
  shift 2
  local n=0
  until "$@" >/dev/null 2>&1; do
    n=$((n + 1))
    if [ "$n" -ge "$tries" ]; then
      echo "TIMEOUT waiting for $label" >&2
      return 1
    fi
    sleep 2
  done
  echo "ready: $label"
}

funded() { [ "$($1 walletbalance | jq -r .confirmed_balance)" -gt 0 ]; }
payable() { $1 queryroutes --dest="$2" --amt="$3" | jq -e '.routes | length > 0' >/dev/null; }
channelled() { $1 listchannels | jq -e --arg pk "$2" '[.channels[] | select(.remote_pubkey==$pk)] | length > 0' >/dev/null; }
routes() { $1 queryroutes --dest="$2" --amt="$3" 2>/dev/null | jq -e '.routes | length > 0' >/dev/null; }
held() { [ "$(wrapper lookupinvoice "$1" | jq -r .state)" = "ACCEPTED" ]; }
mine() { chain generatetoaddress "$1" "$COINBASE" >/dev/null; }

cd "$(dirname "$0")"

say "bringing the regtest stack up"
mkdir -p volumes/chain volumes/payer volumes/wrapper volumes/payee
USERID=$(id -u) GROUPID=$(id -g) docker compose -f compose.yaml up -d >/dev/null

say "chain first, because LND withholds its RPC until the backend is synced"
await "chain rpc" 60 bitcoind getblockchaininfo
chain getwalletinfo >/dev/null 2>&1 || bitcoind loadwallet reg >/dev/null 2>&1 || bitcoind createwallet reg >/dev/null
COINBASE=$(chain getnewaddress)
mine 101

say "waiting for each node to answer a real authenticated call"
await "payer rpc" 120 payer getinfo
await "wrapper rpc" 120 wrapper getinfo
await "payee rpc" 120 payee getinfo

say "funding the two LND wallets"
for node in payer wrapper; do
  chain sendtoaddress "$($node newaddress p2wkh | jq -r .address)" 5 >/dev/null
done
mine 6
await "payer funds" 60 funded payer
await "wrapper funds" 60 funded wrapper

say "opening payer -> wrapper -> payee"
WRAPPER_PK=$(wrapper getinfo | jq -r .identity_pubkey)
PAYEE_PK=$(payee getinfo | jq -r .id)
payer connect "$WRAPPER_PK@wrapper:9735" >/dev/null 2>&1 || true
wrapper connect "$PAYEE_PK@payee:9735" >/dev/null 2>&1 || true
await "payer sees wrapper" 30 payer listpeers
channelled payer "$WRAPPER_PK" || payer openchannel --node_key="$WRAPPER_PK" --local_amt=$CHANNEL_SAT >/dev/null
channelled wrapper "$PAYEE_PK" || wrapper openchannel --node_key="$PAYEE_PK" --local_amt=$CHANNEL_SAT >/dev/null
mine 6
await "payer route to wrapper" 90 payable payer "$WRAPPER_PK" $(( (WRAP_MSAT + 999) / 1000 ))
await "wrapper route to payee" 90 payable wrapper "$PAYEE_PK" $(( (DUE_MSAT + 999) / 1000 ))

say "making sure both legs can still carry a wrap"
NEEDED_SAT=$(( (WRAP_MSAT + 999) / 1000 ))
DUE_SAT=$(( (DUE_MSAT + 999) / 1000 ))
routes payer "$WRAPPER_PK" "$NEEDED_SAT" ||
  wrapper payinvoice --force --json "$(payer addinvoice --amt=$TOP_UP_SAT | jq -r .payment_request)" >/dev/null
routes wrapper "$PAYEE_PK" "$DUE_SAT" ||
  payee pay "$(wrapper addinvoice --amt=$TOP_UP_SAT | jq -r .payment_request)" >/dev/null
await "payer route to wrapper" 30 payable payer "$WRAPPER_PK" "$NEEDED_SAT"
await "wrapper route to payee" 30 payable wrapper "$PAYEE_PK" "$DUE_SAT"

say "step 1: the payee mints its own invoice"
INVOICE=$(payee invoice "$DUE_MSAT" "wrap-proof-$RANDOM" "the recipient own invoice")
PAYEE_BOLT11=$(echo "$INVOICE" | jq -r .bolt11)
HASH=$(echo "$INVOICE" | jq -r .payment_hash)
echo "payment hash $HASH"

say "step 2: the wrapper mints a hold invoice on that same hash"
WRAP_BOLT11=$(wrapper addholdinvoice --amt_msat=$WRAP_MSAT "$HASH" | jq -r .payment_request)
echo "wrap asks $WRAP_MSAT msat to forward $DUE_MSAT msat"

say "step 3: the payer pays the wrap, which must hang"
payer payinvoice --force --json "$WRAP_BOLT11" > /tmp/wrap-payer-out.json 2>&1 &
PAYER_PID=$!
await "wrap held" 60 held "$HASH"

say "step 4: THE TEST - one LND pays hash H while holding an invoice on hash H"
FORWARD=$(wrapper payinvoice --force --json "$PAYEE_BOLT11")
PREIMAGE=$(echo "$FORWARD" | jq -r '.payment_preimage // empty')
if [ -z "$PREIMAGE" ]; then
  echo "FAILED: the forward returned no preimage" >&2
  echo "$FORWARD" >&2
  exit 1
fi
echo "PASS: the forward returned preimage $PREIMAGE"

say "step 5: settling the wrap with the preimage the forward revealed"
wrapper settleinvoice "$PREIMAGE" >/dev/null
wait $PAYER_PID || true

say "verdict"
echo "wrap invoice    $(wrapper lookupinvoice "$HASH" | jq -r .state)"
echo "payee invoice   $(payee listinvoices | jq -r --arg h "$HASH" '.invoices[] | select(.payment_hash==$h) | .status')"
echo "payer payment   $(jq -r '.status // .payment_error // "unknown"' /tmp/wrap-payer-out.json 2>/dev/null || true)"
echo "wrapper kept    $((WRAP_MSAT - DUE_MSAT)) msat before routing fees"
