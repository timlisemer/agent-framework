build:
    npm run build
    echo '{"commitCount":'"$(git rev-list --count HEAD)"'}' > dist/version-data.json

check:
    npx tsc --noEmit
    npx vitest run --reporter=verbose

clean:
    rm -rf dist

install:
    npm install
