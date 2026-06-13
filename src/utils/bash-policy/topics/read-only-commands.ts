export const READ_ONLY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "tree", "pwd", "dirname", "basename", "realpath", "readlink",
  "cat", "grep", "rg", "find", "fd", "sed", "awk", "nl",
  "wc", "sort", "uniq", "cut", "tr", "diff", "comm",
  "head", "tail",
  "file", "stat",
  "jq", "xargs",
  "which", "type",
  "git",
  "echo", "printf",
]);
