# agent-comm — Makefile
#
# Convenience wrapper around the relay + send/wait bridge.
#
# The relay is a single shared background service. Each agent (normally a
# separate terminal) talks to it with `make send` / `make listen` / `make done`.
#
# Common flow:
#   make install            # one-time: install the `ws` dependency
#   make relay              # start the shared relay in the background
#   make send FROM=A TEXT="hi B"
#   make listen FROM=A      # blocks until a message arrives, then exits
#   make done  FROM=A TEXT="bye"
#   make demo               # run two mock agents end-to-end (proof it works)
#   make stop               # stop the relay
#
# Override defaults inline, e.g.:  make relay PORT=9100

# ---- Config (override on the command line) --------------------------------
PORT      ?= 9000
RELAY_URL ?= ws://127.0.0.1:$(PORT)
FROM      ?= A
TEXT      ?=
IDLE      ?= 900

PIDFILE := .relay.pid
LOGFILE := relay.log

# Child node processes (send.js / wait.js) read this from the environment.
export RELAY_URL

.DEFAULT_GOAL := help
.PHONY: help install relay start stop restart status logs send listen fresh-listen done demo clean distclean

help: ## Show this help
	@echo "agent-comm — targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Config (override inline): PORT=$(PORT)  FROM=$(FROM)  IDLE=$(IDLE)"
	@echo "Example: make send FROM=A TEXT=\"hello B\""

install: ## Install dependencies (the `ws` package)
	npm install --no-audit --no-fund

relay: start ## Alias for `start`

start: ## Start the relay in the background (idempotent)
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "relay already running (pid $$(cat $(PIDFILE))) on $(RELAY_URL)"; \
	else \
		rm -f .seq.* inbox.*.md; \
		nohup node relay.js $(PORT) > $(LOGFILE) 2>&1 & echo $$! > $(PIDFILE); \
		sleep 1; \
		if kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
			echo "relay started on $(RELAY_URL) (pid $$(cat $(PIDFILE))) — log: $(LOGFILE)"; \
		else \
			echo "relay FAILED to start — see $(LOGFILE):"; tail -3 $(LOGFILE); rm -f $(PIDFILE); exit 1; \
		fi; \
	fi

stop: ## Stop the background relay
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		kill $$(cat $(PIDFILE)) && echo "relay stopped (pid $$(cat $(PIDFILE)))"; \
		rm -f $(PIDFILE); \
	else \
		echo "no running relay (no live $(PIDFILE))"; rm -f $(PIDFILE); \
	fi

restart: stop start ## Restart the relay

status: ## Show whether the relay is running
	@if [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		echo "relay RUNNING (pid $$(cat $(PIDFILE))) on $(RELAY_URL)"; \
	else \
		echo "relay STOPPED"; \
	fi

logs: ## Tail the relay log
	@touch $(LOGFILE); tail -f $(LOGFILE)

send: ## Send a message:  make send FROM=A TEXT="hello B"
	@if [ -z '$(TEXT)' ]; then echo "usage: make send FROM=<name> TEXT=\"...\""; exit 2; fi
	@node send.js --from $(FROM) --text '$(TEXT)'

listen: ## Block until a message arrives, then exit:  make listen FROM=A [IDLE=900]
	@node wait.js --from $(FROM) --idle $(IDLE); echo "(wait.js exit code: $$?)"

fresh-listen: ## Like listen but join at the live head (skip backlog):  make fresh-listen FROM=A
	@node wait.js --from $(FROM) --idle $(IDLE) --fresh; echo "(wait.js exit code: $$?)"

done: ## Send a final message and end the conversation:  make done FROM=A TEXT="bye"
	@if [ -z '$(TEXT)' ]; then echo "usage: make done FROM=<name> TEXT=\"...\""; exit 2; fi
	@node send.js --from $(FROM) --text '$(TEXT)' --done

demo: ## Run two mock agents talking end-to-end (starts its own relay)
	@PORT=$(PORT) RELAY_URL=$(RELAY_URL) ./demo.sh

clean: ## Remove generated files (inboxes, cursors, logs, pidfile)
	@rm -f inbox.*.md .seq.* $(LOGFILE) relay.demo.log conversation.log $(PIDFILE)
	@echo "cleaned generated files"

distclean: clean ## clean + remove node_modules
	@rm -rf node_modules
	@echo "removed node_modules"
