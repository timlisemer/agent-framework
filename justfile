build:
    npm run build
    echo '{"commitCount":'"$(git rev-list --count HEAD 2>/dev/null || echo 0)"'}' > dist/version-data.json

check:
    npx tsc --noEmit
    npx vitest run --reporter=verbose
    npx tsx scripts/check-fixture-purity.ts

clean:
    rm -rf dist

install:
    npm install
