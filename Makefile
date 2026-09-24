# One place for the commands this repository runs. Every target is a thin wrapper over a pnpm script or `uv run rt511`, so the README's longer forms still work and stay the source of truth for what each command does.
#
#   make                                       list the targets
#   make setup                                 first run: dependencies and every included city
#   make up                                    server and detector together, one Ctrl+C stops both
#   make add-city CITY="Des Moines, IA"        city, catalog and graph in one go
#
# Variables pass straight through, e.g. `make start ARGS="--regions oakland-ca"` or `make detect DEVICE=cpu`.

.DEFAULT_GOAL := help
.PHONY: help setup install sync start serve dev up build check test test-server test-python figures \
	detect detect-cpu sources regions index metros city catalog graph counts add-city

# Extra arguments for the server, e.g. ARGS="--regions oakland-ca,des-moines-ia --cameras freeway".
ARGS ?=
# Torch device for the detector. Empty lets Ultralytics pick the GPU when there is one.
DEVICE ?=
WEIGHTS ?= data/models/yolo26n.pt
DETECT_PORT ?= 8513
RADIUS ?= 15
LIMIT ?= 80

# Pinned and run through uvx, so the linter needs no entry in uv.lock and every machine runs the same version.
RUFF = uvx ruff@0.16.8

DETECT = uv run rt511 detect --weights $(WEIGHTS) --port $(DETECT_PORT) $(if $(DEVICE),--device $(DEVICE))

help: ## list the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- setup

setup: ## first run: install dependencies and build every included city (a few minutes; Overpass is paced)
	pnpm install
	uv sync
	@test -f .env || cp .env.example .env
	uv run rt511 setup

install: ## install JavaScript and Python dependencies, detector included
	pnpm install
	uv sync --extra detector

sync: ## Python dependencies only, detector included (plain `uv sync` would remove ultralytics)
	uv sync --extra detector

# --- serving

start: ## build, then serve on 8511
	pnpm start $(ARGS)

serve: ## serve without rebuilding
	pnpm serve $(ARGS)

dev: ## Vite with hot reload on 5173 and the API on 8511
	pnpm dev

detect: ## serve the YOLO26 vehicle detector on 8513 (DEVICE=cpu when the GPU is busy)
	$(DETECT)

detect-cpu: ## the detector on the CPU
	$(MAKE) detect DEVICE=cpu

up: ## build, then run the server and the detector together
	pnpm build
	pnpm exec concurrently -n api,yolo -c cyan,yellow -k "node server/dist/server/src/index.js $(ARGS)" "$(DETECT)"

# --- checks

build: ## build the server and the wall
	pnpm build

check: ## type-check everything and lint the Python
	pnpm check
	$(RUFF) check src tests

test: test-server test-python ## every test suite

test-server:
	pnpm --filter @rt511/server test

test-python:
	uv run python -m unittest discover -s tests

figures: ## redraw docs/figures from the built constants, after a tuning change
	pnpm --filter @rt511/server run build
	node scripts/figures.mjs

# --- the offline pipeline

sources: ## list the 511 sites and what each publishes
	uv run rt511 sources

regions: ## list configured regions and what has been built
	uv run rt511 regions

index: ## fetch every camera position nationally, for the national map
	uv run rt511 index

metros: ## show where cameras cluster nationally
	uv run rt511 metros --top 20 --name

city: ## create a region: CITY="Des Moines, IA" [RADIUS=15 LIMIT=80]
	@test -n "$(CITY)" || { echo 'usage: make city CITY="Des Moines, IA"'; exit 1; }
	uv run rt511 city "$(CITY)" --radius $(RADIUS) --limit $(LIMIT)

catalog: ## fetch a region's camera catalog: REGION=des-moines-ia
	@test -n "$(REGION)" || { echo 'usage: make catalog REGION=des-moines-ia'; exit 1; }
	uv run rt511 catalog --region $(REGION)

graph: ## build a region's camera site graph: REGION=des-moines-ia
	@test -n "$(REGION)" || { echo 'usage: make graph REGION=des-moines-ia'; exit 1; }
	uv run rt511 build --region $(REGION)

counts: ## join published traffic counts, Iowa and Kentucky: REGION=des-moines-ia
	@test -n "$(REGION)" || { echo 'usage: make counts REGION=des-moines-ia'; exit 1; }
	uv run rt511 counts --region $(REGION)

add-city: ## city, catalog and graph in one go: CITY="Des Moines, IA"
	@test -n "$(CITY)" || { echo 'usage: make add-city CITY="Des Moines, IA"'; exit 1; }
	@key=$$(uv run rt511 city "$(CITY)" --radius $(RADIUS) --limit $(LIMIT) | tee /dev/stderr | sed -n "s/.*-> region '\([^']*\)'.*/\1/p"); \
	test -n "$$key" || { echo "could not read the region key"; exit 1; }; \
	uv run rt511 catalog --region $$key && uv run rt511 build --region $$key
