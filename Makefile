.PHONY: build check clean install

build:
	npm run build

check:
	npx tsc --noEmit

clean:
	rm -rf dist

install:
	npm install
