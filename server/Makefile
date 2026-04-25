VERSION ?= $(shell git describe --tags --dirty --always 2>/dev/null || echo "0.0.0-dev")
LDFLAGS := -X main.Version=$(VERSION)

CMD       := ./cmd/obsidian-remote-server
BIN_DIR   := bin
DIST_DIR  := dist

.PHONY: build clean cross test fmt

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/obsidian-remote-server $(CMD)

cross:
	mkdir -p $(DIST_DIR)
	GOOS=linux  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST_DIR)/obsidian-remote-server-linux-amd64  $(CMD)
	GOOS=linux  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST_DIR)/obsidian-remote-server-linux-arm64  $(CMD)
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST_DIR)/obsidian-remote-server-darwin-amd64 $(CMD)
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST_DIR)/obsidian-remote-server-darwin-arm64 $(CMD)

test:
	go test ./...

fmt:
	gofmt -w .

clean:
	rm -rf $(BIN_DIR) $(DIST_DIR)
