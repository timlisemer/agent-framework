.PHONY: build run check clean install

build:
	npm run build

run: build
	npm run mcp

check:
	npx tsc --noEmit

clean:
	rm -rf dist

install:
	npm install
