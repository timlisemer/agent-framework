export interface BashExpansionReadProofCase {
  literalPath: string;
  quotedCommand: string;
  unquotedCommand: string;
}

export function bashExpansionReadProofCases(): BashExpansionReadProofCase[] {
  return [
    "/tmp/plan*.md",
    "/tmp/plan?.md",
    "/tmp/plan[12].md",
    "$PLAN_FILE",
    "~/plan.md",
    "/tmp/{first,second}.md",
  ].map((literalPath) => ({
    literalPath,
    quotedCommand: `cat '${literalPath}'`,
    unquotedCommand: `cat ${literalPath}`,
  }));
}

export function bashReadCapabilityCommands(path: string): string[] {
  return [
    `cat '${path}'`,
    `head -n 20 '${path}'`,
    `sed -n '1,200p' '${path}'`,
    `tail -n 20 '${path}'`,
  ];
}

export function bashNoReadCapabilityCommands(path: string): string[] {
  return [
    "pwd",
    `ls '${path}'`,
    `find . -name '${path}'`,
    `rg plan '${path}'`,
    `grep plan '${path}'`,
    `file '${path}'`,
    `stat '${path}'`,
    `wc -l '${path}'`,
    "cat",
    "sed -n '1,200p'",
    "xargs cat",
    "cat `pwd`",
    `jq -n . '${path}'`,
    `jq --null-input . '${path}'`,
    `jq --args . '${path}'`,
    `jq --jsonargs . '${path}'`,
    `jq -rn . '${path}'`,
    ...bashReadProofExcludedCommands(path),
    `awk -W version '${path}'`,
    `awk -Wversion '${path}'`,
    `cat --help '${path}'`,
    `cat --version '${path}'`,
    `awk --help '${path}'`,
    `cut --help '${path}'`,
    `head --version '${path}'`,
    `jq --help '${path}'`,
    `nl --version '${path}'`,
    `sed --help '${path}'`,
    `tail --version '${path}'`,
    "tail +2",
    `cat --h '${path}'`,
    `cat --ver '${path}'`,
    `cat --definitely-unknown '${path}'`,
    `cat '${path}'>/dev/stdout`,
    `awk 'BEGIN { exit }' '${path}'`,
    `head -n 0 '${path}'`,
    `head --bytes=0 '${path}'`,
    `head -n nope '${path}'`,
    `head --bytes=invalid '${path}'`,
    `tail -n0 '${path}'`,
    `tail --lines 0 '${path}'`,
    `tail -n nope '${path}'`,
    `tail --bytes=invalid '${path}'`,
    `head '${path}' -n`,
    `tail '${path}' --lines`,
    `sed '1p' '${path}' -l`,
    `cat '${path}`,
    `cat "${path}`,
    `cat ${path}\\`,
    `cat (${path})`,
    `cat '${path}';;`,
    `; cat '${path}'`,
    `cat '${path}'\n;;`,
    `cat '${path}'\n`,
    `sh -c "cat '${path}'"`,
    `eval "cat '${path}'"`,
    `sudo cat '${path}'`,
    `cat <'${path}'`,
    `cat unrelated.md<'${path}'`,
    `cat <<< '${path}'`,
    `cat <<'EOF'`,
    `sed --quiet=garbage 'p' '${path}'`,
    `printf 'checking\\n'; cat '${path}'`,
    `cat /dev/zero; cat '${path}'`,
    `tail -f unrelated.md; cat '${path}'`,
    `cat '${path}' >&/dev/null`,
    `cat '${path}' 1>&-`,
    `cat '${path}' 1>&2`,
    `cat /dev/zero '${path}'`,
    `sed -n '1p' /dev/zero '${path}'`,
    `cut '${path}'`,
    `cut -d abc -f1 '${path}'`,
    `cut -d: -f nope '${path}'`,
    `cut -b1 -f1 '${path}'`,
    `jq --arg=name value . '${path}'`,
    `nl -b invalid '${path}'`,
  ];
}

export function bashDoesNotReadRequiredPathCommands(path: string): string[] {
  return [
    `cat "${path.replace(/\./g, "\\.")}"`,
    `sed -n '1,240p' '${path}.bak'`,
    `head -n '${path}' unrelated.md`,
    `sed -n '${path}' unrelated.md`,
    `awk '${path}' unrelated.md`,
    `jq '${path}' unrelated.json`,
    `cut -d '${path}' -f1 unrelated.md`,
    `head -vn '${path}' unrelated.md`,
    `cut -sf '${path}' unrelated.md`,
    `cut -O '${path}' -f1 unrelated.md`,
    `cut -F '${path}' unrelated.md`,
    `sed -l '${path}' 'p' unrelated.md`,
    `jq --arg name -f '${path}' unrelated.json`,
    `jq --argfile config '${path}' . unrelated.json`,
    `awk -vfoo=f '${path}' unrelated.md`,
    `xargs cat 'unrelated; cat ${path}'`,
  ];
}

export function bashReadProofExcludedCommands(path: string): string[] {
  return [
    `printf 'ok\\n' || cat '${path}'`,
    `cat '${path}' || printf 'recovered\\n'`,
    `printf 'ok\\n' && cat '${path}'`,
    `grep needle unrelated.md && cat '${path}'`,
    `xargs -r cat '${path}'`,
    `xargs --no-run-if-empty cat '${path}'`,
    `xargs -I {} cat '${path}'`,
    `xargs -I{} cat '${path}'`,
    `xargs --replace={} cat '${path}'`,
    `xargs --no-run-if-e cat '${path}'`,
    `xargs --repl={} cat '${path}'`,
    `xargs -p cat '${path}'`,
    `xargs --interactive cat '${path}'`,
    `xargs --definitely-unknown cat '${path}'`,
    `xargs -n nope cat '${path}'`,
    `xargs --max-args=nope cat '${path}'`,
    `xargs --show-limits cat '${path}'`,
    `xargs -L 1 cat '${path}'`,
    `xargs -s 1 cat '${path}'`,
    `xargs -x cat '${path}'`,
    `xargs -a /definitely/missing/agent-framework-xargs-input cat '${path}'`,
    `xargs --arg-file=/definitely/missing/agent-framework-xargs-input cat '${path}'`,
    `xargs -o cat '${path}'`,
    `xargs --open-tty cat '${path}'`,
    `xargs cat '${path}'`,
    `printf '%s\\n' --help | xargs cat '${path}'`,
    `printf '%s\\n' -n0 | xargs head '${path}'`,
    `cat '${path}' | head -n 0`,
    `cat '${path}' | tail -n 0`,
    `cat '${path}' > /dev/null`,
    `cat '${path}' > /dev/shm/agent-framework-read-copy.md`,
  ];
}

export function unsafeBashReadCommands(path: string): string[] {
  return [
    `sed -i 's/a/b/' '${path}'`,
    `cat '${path}' > /tmp/agent-framework-read-copy.md`,
    `awk '{ print }' '${path}' > /tmp/agent-framework-read-copy.md`,
  ];
}
