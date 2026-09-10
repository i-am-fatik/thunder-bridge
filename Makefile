.PHONY: docs gateway

docs:
	npm run docs:serve

gateway: data/cluster.key
	@echo "http://127.0.0.1:$${PORT:-3000}/docs"
	CLUSTER_KEY=$$(cat data/cluster.key) HOST=$${HOST:-127.0.0.1} MINTING=$${MINTING:-1} SWARM=$${SWARM:-0} npm start

data/cluster.key:
	@mkdir -p data
	@openssl rand -hex 32 > $@
	@chmod 600 $@
