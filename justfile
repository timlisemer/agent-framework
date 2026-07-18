build:
    npm run build
    node scripts/update-codex-hook-state.mjs
    echo '{"commitCount":'"$(git rev-list --count HEAD 2>/dev/null || echo 0)"'}' > dist/version-data.json

check:
    npx tsc --noEmit
    npx vitest run
    npx tsx scripts/check-fixture-purity.ts
    npx tsx scripts/generate-scenario-protocol.ts --check
    npx tsx scripts/generate-tester-agent-instructions.ts --check

clean:
    rm -rf dist

install:
    npm install
