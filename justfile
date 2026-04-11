build:
    npm run build
    echo '{"commitCount":'"$(git rev-list --count HEAD 2>/dev/null || echo 0)"'}' > dist/version-data.json

check:
    npx tsc --noEmit
    npx vitest run --reporter=verbose

clean:
    rm -rf dist

install:
    npm install
