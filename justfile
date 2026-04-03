build:
    npm run build

check:
    npx tsc --noEmit
    npx vitest run --reporter=verbose

clean:
    rm -rf dist

install:
    npm install
